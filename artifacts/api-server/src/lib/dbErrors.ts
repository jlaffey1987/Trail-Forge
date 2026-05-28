/**
 * Supabase / PostgREST error classification helpers.
 *
 * These were previously copy-pasted into 8 route and lib files.
 * Import from here instead.
 */

type DbError = { code?: string; message?: string } | null;

/**
 * Returns true when the Supabase error indicates a missing table or view.
 *
 * Matches:
 *   42P01  — PostgreSQL "relation does not exist"
 *   PGRST205 — PostgREST "Could not find the table"
 */
export function isMissingTableError(err: DbError): boolean {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    /relation .* does not exist/i.test(err.message ?? "") ||
    /Could not find the table/i.test(err.message ?? "")
  );
}

/**
 * Returns true when the Supabase error indicates a missing column.
 *
 * Matches:
 *   42703    — PostgreSQL "column does not exist"
 *   PGRST204 — PostgREST "Could not find the column"
 */
export function isMissingColumnError(err: DbError): boolean {
  if (!err) return false;
  return (
    err.code === "42703" ||
    err.code === "PGRST204" ||
    /column .* does not exist/i.test(err.message ?? "") ||
    /Could not find the .* column/i.test(err.message ?? "")
  );
}
