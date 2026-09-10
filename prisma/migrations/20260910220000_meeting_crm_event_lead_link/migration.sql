-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "guestUserDataId" TEXT;

-- AlterTable
ALTER TABLE "CrmEvent" ADD COLUMN "guestUserDataId" TEXT;

-- CreateIndex
CREATE INDEX "Meeting_guestUserDataId_idx" ON "Meeting"("guestUserDataId");

-- CreateIndex
CREATE INDEX "CrmEvent_guestUserDataId_idx" ON "CrmEvent"("guestUserDataId");

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_guestUserDataId_fkey" FOREIGN KEY ("guestUserDataId") REFERENCES "GuestUserData"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEvent" ADD CONSTRAINT "CrmEvent_guestUserDataId_fkey" FOREIGN KEY ("guestUserDataId") REFERENCES "GuestUserData"("id") ON DELETE SET NULL ON UPDATE CASCADE;
