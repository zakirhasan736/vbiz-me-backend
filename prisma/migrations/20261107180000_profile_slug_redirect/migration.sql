-- CreateTable
CREATE TABLE "ProfileSlugRedirect" (
    "id" TEXT NOT NULL,
    "oldSlug" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileSlugRedirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileSlugRedirect_oldSlug_key" ON "ProfileSlugRedirect"("oldSlug");

-- CreateIndex
CREATE INDEX "ProfileSlugRedirect_profileId_idx" ON "ProfileSlugRedirect"("profileId");

-- AddForeignKey
ALTER TABLE "ProfileSlugRedirect" ADD CONSTRAINT "ProfileSlugRedirect_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
