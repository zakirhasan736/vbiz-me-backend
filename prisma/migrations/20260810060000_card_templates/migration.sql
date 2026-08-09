-- CreateTable
CREATE TABLE "CardTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardTemplate_status_sortOrder_idx" ON "CardTemplate"("status", "sortOrder");

-- Seed fixed vCard shells
INSERT INTO "CardTemplate" ("id", "name", "description", "status", "sortOrder", "createdAt", "updatedAt")
VALUES
  (
    'v3',
    'Ocean Profile',
    'Redesign home hero, notepad, and floating navigation (public default).',
    'active',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'v2',
    'Link in Bio',
    'Bento dashboard home, cover video, and categorized floating navigation.',
    'active',
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'v1',
    'Classic Profile',
    'Geometric grid background, typewriter home, and compact icon dock navigation.',
    'active',
    2,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );
