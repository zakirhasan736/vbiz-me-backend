-- Per-account onboarding tour flags (survives browser cache clear).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "completedTours" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
