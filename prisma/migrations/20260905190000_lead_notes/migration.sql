-- CreateTable
CREATE TABLE "LeadNote" (
    "id" TEXT NOT NULL,
    "guestUserDataId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT,
    "audioUrl" TEXT,
    "audioFileName" TEXT,
    "audioMimeType" TEXT,
    "startsAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadNote_guestUserDataId_createdAt_idx" ON "LeadNote"("guestUserDataId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadNote_createdById_idx" ON "LeadNote"("createdById");

-- AddForeignKey
ALTER TABLE "LeadNote" ADD CONSTRAINT "LeadNote_guestUserDataId_fkey" FOREIGN KEY ("guestUserDataId") REFERENCES "GuestUserData"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadNote" ADD CONSTRAINT "LeadNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
