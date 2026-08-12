-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "blocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "SupportTicket_blocked_idx" ON "SupportTicket"("blocked");
