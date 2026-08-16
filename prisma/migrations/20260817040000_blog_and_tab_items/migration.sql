-- Blog dedicated table + TabItem for remaining direct tabs
CREATE TABLE IF NOT EXISTS "Blog" (
    "id" TEXT NOT NULL,
    "legacyPostId" INTEGER,
    "profileId" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "category" TEXT,
    "date" TEXT,
    "url" TEXT,
    "featuredImage" TEXT,
    "status" TEXT NOT NULL DEFAULT '1',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Blog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Blog_legacyPostId_key" ON "Blog"("legacyPostId");
CREATE INDEX IF NOT EXISTS "Blog_profileId_idx" ON "Blog"("profileId");
CREATE INDEX IF NOT EXISTS "Blog_profileId_status_idx" ON "Blog"("profileId", "status");
CREATE INDEX IF NOT EXISTS "Blog_legacyPostId_idx" ON "Blog"("legacyPostId");

ALTER TABLE "Blog" DROP CONSTRAINT IF EXISTS "Blog_profileId_fkey";
ALTER TABLE "Blog" ADD CONSTRAINT "Blog_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "TabItem" (
    "id" TEXT NOT NULL,
    "legacyPostId" INTEGER,
    "legacyPostTypeId" INTEGER,
    "profileId" TEXT NOT NULL,
    "tabKey" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "url" TEXT,
    "featuredImage" TEXT,
    "status" TEXT NOT NULL DEFAULT '1',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metas" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TabItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TabItem_legacyPostId_key" ON "TabItem"("legacyPostId");
CREATE INDEX IF NOT EXISTS "TabItem_profileId_idx" ON "TabItem"("profileId");
CREATE INDEX IF NOT EXISTS "TabItem_profileId_tabKey_idx" ON "TabItem"("profileId", "tabKey");
CREATE INDEX IF NOT EXISTS "TabItem_tabKey_idx" ON "TabItem"("tabKey");
CREATE INDEX IF NOT EXISTS "TabItem_legacyPostId_idx" ON "TabItem"("legacyPostId");

ALTER TABLE "TabItem" DROP CONSTRAINT IF EXISTS "TabItem_profileId_fkey";
ALTER TABLE "TabItem" ADD CONSTRAINT "TabItem_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
