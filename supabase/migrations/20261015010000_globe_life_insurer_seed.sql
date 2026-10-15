-- ============================================================================
-- P4-P13: Seed "Globe Life Insurance Co. of New York" in insurer_catalog
--
-- The payer's own EOP documents identify themselves as "Globe Life
-- Insurance Co. of New York" (see the printed letterhead/footer). Staff
-- commonly call it "Global Life Insurance" by ear -- recorded here as an
-- alias (same mechanism as the existing "United Healthcare Medicare" ->
-- "United Healthcare Medicare Advantage" rename in the insurer_catalog
-- migration) so patient/claim records saved under either spelling resolve
-- to the same catalog entry, without merging it into any other, unrelated
-- insurer.
--
-- ON CONFLICT DO NOTHING (not an UPDATE) -- idempotent/safe to re-run, and
-- deliberately never reactivates a copy of this row an admin has since
-- soft-deleted via insurance.delete (P4-P13's is_active flag).
-- ============================================================================

BEGIN;

INSERT INTO public.insurer_catalog (name, aliases)
VALUES (
  'Globe Life Insurance Co. of New York',
  ARRAY['Global Life Insurance', 'Globe Life', 'Globe Life Insurance']
)
ON CONFLICT (normalized_name) DO NOTHING;

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DELETE FROM public.insurer_catalog WHERE normalized_name = 'globe life insurance co. of new york';
-- COMMIT;
