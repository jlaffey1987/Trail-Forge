/**
 * Lightweight in-memory mock of the Supabase service-role client.
 *
 * Implements just enough of `@supabase/supabase-js`'s thenable PostgrestFilterBuilder
 * surface to exercise the trailContent route handlers:
 *
 *   from(table).select(cols).eq(col, v).is(col, null).order(col, opts).limit(n)
 *   from(table).select(cols).eq(...).maybeSingle()
 *   from(table).insert(row).select(cols).single()
 *   from(table).update(row).eq(...)
 *   from(table).update(row).eq(...).select(cols).single()
 *   from(table).delete().eq(...)
 *   from(table).select(cols).in(col, ids).is(col, null)
 *   from(table).select(cols).in(col, ids).eq(col, v)
 *
 * Joins of the form `users(id, display_name, avatar_url)` in a column list are
 * resolved by looking up the row's `*_user_id` field in the seeded `users` table.
 *
 * This is intentionally narrow — adding query syntax not used by the route
 * under test would just add untested code.
 */

import { randomUUID } from "crypto";

type Row = Record<string, unknown>;

interface OrderState {
  col: string;
  ascending: boolean;
}

type Filter =
  | { type: "eq"; col: string; val: unknown }
  | { type: "neq"; col: string; val: unknown }
  | { type: "gt"; col: string; val: unknown }
  | { type: "lt"; col: string; val: unknown }
  | { type: "is"; col: string; val: unknown }
  | { type: "not_is"; col: string; val: unknown }
  | { type: "in"; col: string; vals: unknown[] }
  | { type: "or"; raw: string };

type Op = "select" | "insert" | "update" | "delete" | "upsert" | null;

interface QueryState {
  table: string;
  op: Op;
  cols: string;
  filters: Filter[];
  order: OrderState | null;
  limit: number | null;
  insertRows: Row[];
  updateRow: Row | null;
  postSelectCols: string | null;
  single: boolean;
  maybeSingle: boolean;
  upsertOnConflict: string | null;
  upsertIgnoreDuplicates: boolean;
  countMode: "exact" | null;
  head: boolean;
}

interface PgError {
  code?: string;
  message: string;
}

interface QueryResult {
  data: Row | Row[] | null;
  error: PgError | null;
  count?: number | null;
}

export class MockSupa {
  /** Tables -> rows. */
  public tables: Record<string, Row[]> = {};
  /** Optional: tables that should report "missing" (PGRST205) on read. */
  public missingTables = new Set<string>();
  /** Optional: forced errors per (table, op) — return error from execute. */
  public forcedErrors = new Map<string, PgError>();
  private rpcResults = new Map<string, { data: unknown; error: PgError | null }>();

  setRpcResult(name: string, data: unknown, error: PgError | null = null): void {
    this.rpcResults.set(name, { data, error });
  }

  rpc(name: string, _params?: Record<string, unknown>): Promise<{ data: unknown; error: PgError | null }> {
    const result = this.rpcResults.get(name);
    if (!result) {
      return Promise.resolve({
        data: null,
        error: { code: "42883", message: `MockSupa: no rpc result configured for "${name}"` },
      });
    }
    return Promise.resolve(result);
  }

  seed(table: string, rows: Row[]): void {
    this.tables[table] = rows.map((r) => ({ ...r }));
  }

  insertSeed(table: string, row: Row): Row {
    const r = { ...row };
    if (r.id == null) r.id = randomUUID();
    if (this.tables[table] == null) this.tables[table] = [];
    this.tables[table]!.push(r);
    return r;
  }

  /** Return shallow snapshots of all rows in a table. */
  rows(table: string): Row[] {
    return (this.tables[table] ?? []).map((r) => ({ ...r }));
  }

  from(table: string): QueryBuilder {
    return new QueryBuilder(this, table);
  }

  // Internal — execute a finalized query state.
  _execute(state: QueryState): QueryResult {
    if (this.missingTables.has(state.table) && state.op === "select") {
      return {
        data: null,
        error: { code: "PGRST205", message: `Could not find the table 'public.${state.table}'` },
      };
    }
    const forcedKey = `${state.table}:${state.op}`;
    if (this.forcedErrors.has(forcedKey)) {
      return { data: null, error: this.forcedErrors.get(forcedKey)! };
    }
    if (this.tables[state.table] == null) this.tables[state.table] = [];
    const table = this.tables[state.table]!;

    const matches = (row: Row): boolean => {
      for (const f of state.filters) {
        if (f.type === "eq") {
          if (row[f.col] !== f.val) return false;
        } else if (f.type === "is") {
          // Supabase `is(col, null)` matches null/undefined.
          if (f.val === null) {
            if (row[f.col] != null) return false;
          } else {
            if (row[f.col] !== f.val) return false;
          }
        } else if (f.type === "neq") {
          if (row[f.col] === f.val) return false;
        } else if (f.type === "gt") {
          const rv = row[f.col];
          if (rv == null || rv <= f.val) return false;
        } else if (f.type === "lt") {
          const rv = row[f.col];
          if (rv == null || rv >= f.val) return false;
        } else if (f.type === "not_is") {
          if (f.val === null) {
            if (row[f.col] == null) return false;
          } else {
            if (row[f.col] === f.val) return false;
          }
        } else if (f.type === "in") {
          if (!f.vals.includes(row[f.col])) return false;
        } else if (f.type === "or") {
          const orStr = f.raw;
          const andBlocks = orStr.split("),").map(s => s.replace(/^and\(/, "").replace(/\)$/, ""));
          let anyMatch = false;
          for (const block of andBlocks) {
            const conditions = block.split(",").map(s => s.trim());
            let blockMatch = true;
            for (const cond of conditions) {
              const eqMatch = /^(\w+)\.eq\.(.+)$/.exec(cond);
              if (eqMatch) {
                if (String(row[eqMatch[1]]) !== eqMatch[2]) blockMatch = false;
              }
            }
            if (blockMatch) { anyMatch = true; break; }
          }
          if (!anyMatch) return false;
        }
      }
      return true;
    };

    if (state.op === "select") {
      let rows = table.filter(matches);
      // Count-only query (`.select(cols, { count: 'exact', head: true })`)
      // returns just the matched count; no row payload.
      if (state.head && state.countMode != null) {
        return { data: null, error: null, count: rows.length };
      }
      if (state.order) {
        const { col, ascending } = state.order;
        rows = [...rows].sort((a, b) => {
          const va = a[col];
          const vb = b[col];
          if (va == null && vb == null) return 0;
          if (va == null) return ascending ? -1 : 1;
          if (vb == null) return ascending ? 1 : -1;
          if (va < vb) return ascending ? -1 : 1;
          if (va > vb) return ascending ? 1 : -1;
          return 0;
        });
      }
      if (state.limit != null) rows = rows.slice(0, state.limit);
      const projected = rows.map((r) => this._project(r, state.cols));
      if (state.single) {
        return {
          data: projected[0] ?? null,
          error: projected.length === 0 ? { code: "PGRST116", message: "no rows" } : null,
        };
      }
      if (state.maybeSingle) {
        return { data: projected[0] ?? null, error: null };
      }
      return { data: projected, error: null };
    }

    if (state.op === "upsert") {
      const conflictCols = (state.upsertOnConflict ?? "id").split(",").map(c => c.trim());
      const upserted: Row[] = [];
      for (const incoming of state.insertRows) {
        const row: Row = { ...incoming };
        const existing = table.find((r) =>
          conflictCols.every(col => row[col] != null && r[col] === row[col]),
        );
        if (existing) {
          if (!state.upsertIgnoreDuplicates) Object.assign(existing, row);
          upserted.push(existing);
        } else {
          if (row.id == null) row.id = randomUUID();
          const now = new Date().toISOString();
          if (row.created_at == null) row.created_at = now;
          table.push(row);
          upserted.push(row);
        }
      }
      if (state.postSelectCols != null) {
        const projected = upserted.map((r) =>
          this._project(r, state.postSelectCols!),
        );
        if (state.single) return { data: projected[0] ?? null, error: null };
        return { data: projected, error: null };
      }
      return { data: null, error: null };
    }

    if (state.op === "insert") {
      const inserted: Row[] = [];
      for (const incoming of state.insertRows) {
        const row: Row = { ...incoming };
        if (row.id == null) row.id = randomUUID();
        const now = new Date().toISOString();
        if (row.created_at == null) row.created_at = now;
        if (row.updated_at == null) row.updated_at = now;
        // Default note kind, amendment status, hidden_at where appropriate.
        if (state.table === "trail_notes" && row.kind == null) row.kind = "info";
        if (state.table === "trail_notes" && !("hidden_at" in row)) row.hidden_at = null;
        if (state.table === "trail_photos" && !("hidden_at" in row)) row.hidden_at = null;
        if (state.table === "trail_amendments") {
          if (row.status == null) row.status = "pending";
          if (!("decided_by" in row)) row.decided_by = null;
          if (!("decided_at" in row)) row.decided_at = null;
          if (!("decision_reason" in row)) row.decision_reason = null;
        }
        if (state.table === "trail_shares" && row.shared_at == null) {
          row.shared_at = now;
        }
        table.push(row);
        inserted.push(row);
      }
      if (state.postSelectCols != null) {
        const projected = inserted.map((r) => this._project(r, state.postSelectCols!));
        if (state.single) return { data: projected[0] ?? null, error: null };
        return { data: projected, error: null };
      }
      return { data: null, error: null };
    }

    if (state.op === "update") {
      const updated: Row[] = [];
      for (const r of table) {
        if (matches(r)) {
          Object.assign(r, state.updateRow ?? {});
          updated.push(r);
        }
      }
      if (state.postSelectCols != null) {
        const projected = updated.map((r) => this._project(r, state.postSelectCols!));
        if (state.single) return { data: projected[0] ?? null, error: null };
        return { data: projected, error: null };
      }
      return { data: null, error: null };
    }

    if (state.op === "delete") {
      const remaining: Row[] = [];
      for (const r of table) {
        if (!matches(r)) remaining.push(r);
      }
      this.tables[state.table] = remaining;
      return { data: null, error: null };
    }

    return { data: null, error: null };
  }

  /**
   * Resolve `users(...)` and `groups(...)` joins by linking on the row's
   * matching `*_id` column. Joins not selected in `cols` are left untouched.
   */
  private _project(row: Row, cols: string): Row {
    const out: Row = { ...row };
    const um = /(?:users:(\w+)|users)\s*\(([^)]+)\)/.exec(cols);
    if (um) {
      const fkCol = um[1] ?? null;
      const userId = fkCol
        ? (row[fkCol] as string | undefined) ?? null
        : (row.author_user_id as string | undefined) ??
          (row.owner_user_id as string | undefined) ??
          (row.sender_user_id as string | undefined) ??
          (row.user_id as string | undefined) ??
          null;
      const users = this.tables["users"] ?? [];
      const u = users.find((x) => x.id === userId) ?? null;
      const fields = (um[2] ?? um[1])!.split(",").map((s) => s.trim());
      out.users = u
        ? Object.fromEntries(fields.map((f) => [f, (u as Row)[f] ?? null]))
        : null;
    }
    const gm = /groups\s*\(([^)]+)\)/.exec(cols);
    if (gm) {
      const groupId = row.group_id as string | undefined;
      const groups = this.tables["groups"] ?? [];
      const g = groupId ? groups.find((x) => x.id === groupId) ?? null : null;
      const fields = gm[1]!.split(",").map((s) => s.trim());
      out.groups = g
        ? Object.fromEntries(fields.map((f) => [f, (g as Row)[f] ?? null]))
        : null;
    }
    return out;
  }
}

class QueryBuilder implements PromiseLike<QueryResult> {
  private state: QueryState;

  constructor(private supa: MockSupa, table: string) {
    this.state = {
      table,
      op: null,
      cols: "*",
      filters: [],
      order: null,
      limit: null,
      insertRows: [],
      updateRow: null,
      postSelectCols: null,
      single: false,
      maybeSingle: false,
      upsertOnConflict: null,
      upsertIgnoreDuplicates: false,
      countMode: null,
      head: false,
    };
  }

  select(
    cols: string = "*",
    opts?: { count?: "exact"; head?: boolean },
  ): this {
    if (this.state.op == null) {
      this.state.op = "select";
      this.state.cols = cols;
      if (opts?.count != null) this.state.countMode = opts.count;
      if (opts?.head === true) this.state.head = true;
    } else {
      // Post-mutation `.select(...)` (insert/update with returning).
      this.state.postSelectCols = cols;
    }
    return this;
  }

  insert(row: Row | Row[]): this {
    this.state.op = "insert";
    this.state.insertRows = Array.isArray(row) ? [...row] : [row];
    return this;
  }

  upsert(row: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.state.op = "upsert";
    this.state.insertRows = Array.isArray(row) ? [...row] : [row];
    this.state.upsertOnConflict = opts?.onConflict ?? null;
    this.state.upsertIgnoreDuplicates = opts?.ignoreDuplicates ?? false;
    return this;
  }

  update(row: Row): this {
    this.state.op = "update";
    this.state.updateRow = row;
    return this;
  }

  delete(): this {
    this.state.op = "delete";
    return this;
  }

  eq(col: string, val: unknown): this {
    this.state.filters.push({ type: "eq", col, val });
    return this;
  }

  is(col: string, val: unknown): this {
    this.state.filters.push({ type: "is", col, val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this.state.filters.push({ type: "neq", col, val });
    return this;
  }

  gt(col: string, val: unknown): this {
    this.state.filters.push({ type: "gt", col, val });
    return this;
  }

  lt(col: string, val: unknown): this {
    this.state.filters.push({ type: "lt", col, val });
    return this;
  }

  not(col: string, _operator: string, val: unknown): this {
    this.state.filters.push({ type: "not_is", col, val });
    return this;
  }

  or(raw: string): this {
    this.state.filters.push({ type: "or", raw });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.state.filters.push({ type: "in", col, vals });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.state.order = { col, ascending: opts?.ascending ?? true };
    return this;
  }

  limit(n: number): this {
    this.state.limit = n;
    return this;
  }

  single(): Promise<QueryResult> {
    this.state.single = true;
    return Promise.resolve(this.supa._execute(this.state));
  }

  maybeSingle(): Promise<QueryResult> {
    this.state.maybeSingle = true;
    return Promise.resolve(this.supa._execute(this.state));
  }

  then<TResolve = QueryResult, TReject = never>(
    onfulfilled?: ((value: QueryResult) => TResolve | PromiseLike<TResolve>) | null,
    onrejected?: ((reason: unknown) => TReject | PromiseLike<TReject>) | null,
  ): Promise<TResolve | TReject> {
    return Promise.resolve(this.supa._execute(this.state)).then(onfulfilled, onrejected);
  }
}
