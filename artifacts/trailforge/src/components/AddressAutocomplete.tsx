import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  searchSuggestions,
  type AddressSuggestion,
  type GeoPoint,
} from "@/lib/routing";

interface AddressAutocompleteProps {
  /** Current text shown in the input. Controlled by the parent. */
  value: string;
  /** Called whenever the user types — parent owns the buffer. */
  onChange: (next: string) => void;
  /**
   * Called when the user selects a suggestion (click or Enter on highlight).
   * The parent should treat this as the canonical "geocoded" point and
   * cache it next to the input string so the next "Plan trip" doesn't
   * re-geocode.
   */
  onSelect: (suggestion: AddressSuggestion, point: GeoPoint) => void;
  /** Native `placeholder`. */
  placeholder?: string;
  /** Optional left-side dot colour (start vs end visual cue). */
  dotColor?: string;
  /** Highlight ring (used when handing off from the Map tab). */
  highlight?: boolean;
  /** True once the parent has a confirmed match for `value`. */
  confirmed?: boolean;
  /** Stable test id for end-to-end tests. */
  "data-testid"?: string;
}

const DEBOUNCE_MS = 280;

/**
 * Address autocomplete input — debounced Nominatim suggestions in a
 * dark-themed dropdown that matches the planner panel. Use it instead of
 * a bare `<input>` whenever the user is meant to pick a real-world place.
 *
 * Design notes:
 *  - Debounce + sequence guard: an older inflight request landing after
 *    a newer one will NOT overwrite the dropdown. Stale results are
 *    silently dropped via `seqRef`.
 *  - Keyboard nav: ArrowDown/Up cycle through suggestions, Enter accepts
 *    the highlighted one, Escape dismisses without selecting.
 *  - Mouse-down (not click) on dropdown rows so the input's blur handler
 *    in the parent can still see the picked value before we close.
 *  - We open the dropdown on focus when there are cached suggestions for
 *    the current input so re-focusing without typing still feels alive.
 */
const AddressAutocomplete = forwardRef<
  HTMLInputElement,
  AddressAutocompleteProps
>(function AddressAutocomplete(
  {
    value,
    onChange,
    onSelect,
    placeholder,
    dotColor,
    highlight,
    confirmed,
    "data-testid": testId,
  },
  ref,
) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The exact query string the dropdown was last populated for. We use
  // it as a cache key so re-focusing the field without typing reopens
  // the prior dropdown instead of firing a fresh request.
  const populatedForRef = useRef<string>("");

  const trimmed = value.trim();

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Reset the suggestion list whenever the parent has confirmed the
  // current value (i.e. the user picked a result and the parent
  // geocoded it). Keeps the green tick visible without a stale dropdown
  // hovering over the next field.
  useEffect(() => {
    if (confirmed && populatedForRef.current === trimmed) {
      setSuggestions([]);
      setOpen(false);
    }
  }, [confirmed, trimmed]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      onChange(next);
      const q = next.trim();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (q.length < 2) {
        setSuggestions([]);
        setOpen(false);
        setLoading(false);
        return;
      }
      setOpen(true);
      setLoading(true);
      const mySeq = ++seqRef.current;
      debounceRef.current = setTimeout(() => {
        void (async () => {
          const results = await searchSuggestions(q);
          if (mySeq !== seqRef.current) return; // stale
          populatedForRef.current = q;
          setSuggestions(results);
          setHighlightIdx(0);
          setLoading(false);
        })();
      }, DEBOUNCE_MS);
    },
    [onChange],
  );

  const acceptSuggestion = useCallback(
    (s: AddressSuggestion) => {
      // Update parent text first so the `confirmed` prop can flip in the
      // same render. We then close the dropdown and pass the geocoded
      // point up so the parent can cache it.
      onChange(s.label);
      const pt: GeoPoint = { lat: s.lat, lng: s.lng, label: s.label };
      onSelect(s, pt);
      populatedForRef.current = s.label.trim();
      setOpen(false);
    },
    [onChange, onSelect],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = suggestions[highlightIdx];
      if (pick) acceptSuggestion(pick);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      {dotColor && (
        <div
          className="absolute left-3 top-[1.05rem] w-2 h-2 rounded-full pointer-events-none"
          style={{ backgroundColor: dotColor }}
        />
      )}
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={handleInputChange}
        onFocus={() => {
          if (suggestions.length > 0 && populatedForRef.current === trimmed) {
            setOpen(true);
          }
        }}
        onBlur={() => {
          // Defer the close so a mouse-down on a row still fires.
          setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        data-testid={testId}
        className={`w-full bg-[hsl(22,15%,11%)] border rounded-lg ${
          dotColor ? "pl-8" : "pl-4"
        } pr-9 py-3 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:ring-1 transition-colors ${
          highlight
            ? "border-amber-500 ring-1 ring-amber-500/50"
            : "border-[hsl(30,12%,20%)] focus:border-amber-500/60 focus:ring-amber-500/30"
        }`}
      />
      {confirmed && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-green-400 pointer-events-none">
          <svg
            viewBox="0 0 24 24"
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      )}
      {!confirmed && loading && open && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-400 pointer-events-none">
          <svg
            className="w-4 h-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeOpacity="0.25"
            />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}
      {open && suggestions.length > 0 && (
        <ul
          role="listbox"
          data-testid={testId ? `${testId}-suggestions` : undefined}
          className="absolute z-30 mt-1 left-0 right-0 max-h-60 overflow-auto rounded-lg border border-[hsl(34,18%,24%)] bg-[hsl(22,15%,9%)] shadow-xl"
        >
          {suggestions.map((s, idx) => {
            const active = idx === highlightIdx;
            return (
              <li
                key={s.id}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseDown={(e) => {
                  // Keep focus on the input; we'll close via state.
                  e.preventDefault();
                  acceptSuggestion(s);
                }}
                className={`px-3 py-2 cursor-pointer text-sm border-b border-[hsl(34,18%,18%)] last:border-b-0 ${
                  active
                    ? "bg-amber-600/20 text-amber-100"
                    : "text-stone-300 hover:bg-stone-800/50"
                }`}
              >
                <div className="font-medium leading-tight">{s.shortLabel}</div>
                {s.label !== s.shortLabel && (
                  <div className="text-[11px] text-stone-500 leading-tight truncate mt-0.5">
                    {s.label.replace(s.shortLabel, "").replace(/^,\s*/, "")}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

export default AddressAutocomplete;
