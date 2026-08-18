CREATE TABLE IF NOT EXISTS "ProfileAssistantConfig" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "businessBrief" TEXT NOT NULL DEFAULT '',
  "systemPromptAddendum" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProfileAssistantConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProfileAssistantKnowledge" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "tabScope" TEXT,
  "label" TEXT NOT NULL,
  "sha256" TEXT,
  "extractedText" TEXT NOT NULL,
  "extractionMethod" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProfileAssistantKnowledge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProfileAssistantConfig_profileId_key"
  ON "ProfileAssistantConfig"("profileId");
CREATE INDEX IF NOT EXISTS "ProfileAssistantConfig_profileId_idx"
  ON "ProfileAssistantConfig"("profileId");
CREATE INDEX IF NOT EXISTS "ProfileAssistantKnowledge_profileId_idx"
  ON "ProfileAssistantKnowledge"("profileId");
CREATE INDEX IF NOT EXISTS "ProfileAssistantKnowledge_profileId_tabScope_idx"
  ON "ProfileAssistantKnowledge"("profileId", "tabScope");
CREATE INDEX IF NOT EXISTS "ProfileAssistantKnowledge_profileId_createdAt_idx"
  ON "ProfileAssistantKnowledge"("profileId", "createdAt");
CREATE INDEX IF NOT EXISTS "ProfileAssistantKnowledge_sha256_idx"
  ON "ProfileAssistantKnowledge"("sha256");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProfileAssistantConfig_profileId_fkey'
  ) THEN
    ALTER TABLE "ProfileAssistantConfig"
      ADD CONSTRAINT "ProfileAssistantConfig_profileId_fkey"
      FOREIGN KEY ("profileId") REFERENCES "Profile"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProfileAssistantKnowledge_profileId_fkey'
  ) THEN
    ALTER TABLE "ProfileAssistantKnowledge"
      ADD CONSTRAINT "ProfileAssistantKnowledge_profileId_fkey"
      FOREIGN KEY ("profileId") REFERENCES "Profile"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
