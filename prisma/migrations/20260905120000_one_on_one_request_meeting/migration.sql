-- CreateTable
CREATE TABLE "OneOnOneRequest" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT NOT NULL,
    "guestPhone" TEXT,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "cardOwnerUserId" TEXT,
    "corporateId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneOnOneRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OneOnOneMeeting" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "cardOwnerUserId" TEXT NOT NULL,
    "corporateId" TEXT,
    "zohoCalendarEventId" TEXT,
    "zohoMeetingId" TEXT,
    "zohoMeetingUrl" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OneOnOneMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OneOnOneRequest_profileId_status_idx" ON "OneOnOneRequest"("profileId", "status");
CREATE INDEX "OneOnOneRequest_guestEmail_idx" ON "OneOnOneRequest"("guestEmail");
CREATE INDEX "OneOnOneRequest_status_idx" ON "OneOnOneRequest"("status");
CREATE INDEX "OneOnOneRequest_cardOwnerUserId_idx" ON "OneOnOneRequest"("cardOwnerUserId");
CREATE UNIQUE INDEX "OneOnOneMeeting_requestId_key" ON "OneOnOneMeeting"("requestId");
CREATE INDEX "OneOnOneMeeting_cardOwnerUserId_status_idx" ON "OneOnOneMeeting"("cardOwnerUserId", "status");
CREATE INDEX "OneOnOneMeeting_cardId_idx" ON "OneOnOneMeeting"("cardId");
CREATE INDEX "OneOnOneMeeting_status_idx" ON "OneOnOneMeeting"("status");
CREATE INDEX "OneOnOneMeeting_createdByUserId_idx" ON "OneOnOneMeeting"("createdByUserId");

-- AddForeignKey
ALTER TABLE "OneOnOneRequest" ADD CONSTRAINT "OneOnOneRequest_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OneOnOneRequest" ADD CONSTRAINT "OneOnOneRequest_cardOwnerUserId_fkey" FOREIGN KEY ("cardOwnerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OneOnOneRequest" ADD CONSTRAINT "OneOnOneRequest_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OneOnOneMeeting" ADD CONSTRAINT "OneOnOneMeeting_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "OneOnOneRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OneOnOneMeeting" ADD CONSTRAINT "OneOnOneMeeting_cardOwnerUserId_fkey" FOREIGN KEY ("cardOwnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OneOnOneMeeting" ADD CONSTRAINT "OneOnOneMeeting_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
