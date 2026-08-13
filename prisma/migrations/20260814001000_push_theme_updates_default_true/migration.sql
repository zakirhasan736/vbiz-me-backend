-- AlterTable: theme updates default to on (all categories on when enabling push)
ALTER TABLE "PushNotificationPreference" ALTER COLUMN "themeUpdates" SET DEFAULT true;
