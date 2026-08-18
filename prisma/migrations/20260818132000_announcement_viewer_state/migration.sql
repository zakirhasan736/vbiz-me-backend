CREATE TABLE "AnnouncementViewerState" (
    "id" TEXT NOT NULL,
    "announcementType" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "profileId" TEXT,
    "visitorId" TEXT,
    "browserKey" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3),
    "suppressUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnouncementViewerState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnnouncementViewerState_announcementType_announcementId_brow_key" ON "AnnouncementViewerState"("announcementType", "announcementId", "browserKey");
CREATE INDEX "AnnouncementViewerState_announcementType_announcementId_idx" ON "AnnouncementViewerState"("announcementType", "announcementId");
CREATE INDEX "AnnouncementViewerState_profileId_visitorId_idx" ON "AnnouncementViewerState"("profileId", "visitorId");
CREATE INDEX "AnnouncementViewerState_browserKey_idx" ON "AnnouncementViewerState"("browserKey");
