-- CreateTable
CREATE TABLE IF NOT EXISTS "AboutMe" (
    "id" TEXT NOT NULL,
    "legacyPostId" INTEGER,
    "profileId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'About Me',
    "description" TEXT,
    "featuredMediaUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT '1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AboutMe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AboutMe_legacyPostId_key" ON "AboutMe"("legacyPostId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AboutMe_profileId_key" ON "AboutMe"("profileId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AboutMe_profileId_idx" ON "AboutMe"("profileId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "AboutMe" ADD CONSTRAINT "AboutMe_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
