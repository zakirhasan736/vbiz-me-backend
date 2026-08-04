-- AlterTable
ALTER TABLE "User" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "legacyId" INTEGER,
ADD COLUMN     "pmLastFour" TEXT,
ADD COLUMN     "pmType" TEXT,
ADD COLUMN     "stripeId" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Status" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gender" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaritalStatus" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaritalStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profession" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Country" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "State" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "countryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "State_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "stateId" TEXT,
    "countryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "userId" TEXT,
    "companyUserId" TEXT,
    "createdById" TEXT,
    "statusId" TEXT,
    "genderId" TEXT,
    "maritalStatusId" TEXT,
    "professionId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "prof" TEXT,
    "companyName" TEXT,
    "email" TEXT NOT NULL,
    "website" TEXT,
    "lastName" TEXT,
    "dob" TIMESTAMP(3),
    "phone" TEXT,
    "whatsapp" TEXT,
    "countryCode" TEXT,
    "facebook" TEXT,
    "instagram" TEXT,
    "twitter" TEXT,
    "tiktok" TEXT,
    "youtube" TEXT,
    "rumble" TEXT,
    "truth" TEXT,
    "linkedin" TEXT,
    "pinterest" TEXT,
    "avatar" TEXT,
    "zipCode" TEXT,
    "colorCode" TEXT NOT NULL DEFAULT '#212121',
    "address" TEXT,
    "about" TEXT,
    "isEmploy" BOOLEAN NOT NULL DEFAULT false,
    "designation" TEXT,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "referralCode" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "template" TEXT NOT NULL DEFAULT 'default',
    "themeConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "label" TEXT,
    "line1" TEXT,
    "line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "zipCode" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Education" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "institute" TEXT,
    "degree" TEXT,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "tillNow" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Education_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experience" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "company" TEXT,
    "jobTitle" TEXT,
    "description" TEXT,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "tillNow" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillType" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillTag" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "skillTypeId" TEXT,
    "name" TEXT NOT NULL,
    "level" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "reviewUrl" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostType" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "slug" TEXT,
    "status" TEXT DEFAULT 'active',
    "typeId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "postTypeId" TEXT,
    "title" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT '1',
    "url" TEXT,
    "featuredImage" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostMeta" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "postId" TEXT NOT NULL,
    "metaKey" TEXT NOT NULL,
    "metaValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentType" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "status" TEXT DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "attachmentTypeId" TEXT,
    "attachableType" TEXT NOT NULL,
    "attachableId" TEXT NOT NULL,
    "profileId" TEXT,
    "postId" TEXT,
    "docName" TEXT,
    "url" TEXT,
    "publicId" TEXT,
    "resourceType" TEXT,
    "format" TEXT,
    "bytes" INTEGER,
    "extension" TEXT,
    "mimeType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileSetting" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "profileTemplate" TEXT NOT NULL DEFAULT 'v3',
    "layoutStyle" TEXT,
    "buttonStyle" TEXT,
    "cornerStyle" TEXT,
    "themeConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialLink" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "name" TEXT,
    "url" TEXT,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Menu" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "menuId" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "price" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "message" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestUserData" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestUserData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNote" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT,
    "eventType" TEXT NOT NULL,
    "payload" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "profileId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "endpointHash" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "browser" TEXT,
    "platform" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushNotificationPreference" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "pushSubscriptionId" TEXT NOT NULL,
    "serviceUpdates" BOOLEAN NOT NULL DEFAULT true,
    "portfolioUpdates" BOOLEAN NOT NULL DEFAULT true,
    "contactUpdates" BOOLEAN NOT NULL DEFAULT true,
    "offers" BOOLEAN NOT NULL DEFAULT true,
    "businessHours" BOOLEAN NOT NULL DEFAULT true,
    "news" BOOLEAN NOT NULL DEFAULT true,
    "themeUpdates" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "monthlyPrice" INTEGER NOT NULL DEFAULT 0,
    "yearlyPrice" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageFeature" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "packageId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "featureValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "userId" TEXT NOT NULL,
    "packageId" TEXT,
    "name" TEXT,
    "stripeId" TEXT,
    "stripeStatus" TEXT,
    "stripePrice" TEXT,
    "quantity" INTEGER,
    "trialEndsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "provider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "subscriptionId" TEXT NOT NULL,
    "stripeId" TEXT,
    "stripeProduct" TEXT,
    "stripePrice" TEXT,
    "quantity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT,
    "provider" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEmployee" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Status_legacyId_key" ON "Status"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Status_name_key" ON "Status"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Gender_legacyId_key" ON "Gender"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Gender_name_key" ON "Gender"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MaritalStatus_legacyId_key" ON "MaritalStatus"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "MaritalStatus_name_key" ON "MaritalStatus"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Profession_legacyId_key" ON "Profession"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Profession_name_key" ON "Profession"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Country_legacyId_key" ON "Country"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "State_legacyId_key" ON "State"("legacyId");

-- CreateIndex
CREATE INDEX "State_countryId_idx" ON "State"("countryId");

-- CreateIndex
CREATE UNIQUE INDEX "City_legacyId_key" ON "City"("legacyId");

-- CreateIndex
CREATE INDEX "City_stateId_idx" ON "City"("stateId");

-- CreateIndex
CREATE INDEX "City_countryId_idx" ON "City"("countryId");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_legacyId_key" ON "Profile"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_slug_key" ON "Profile"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_referralCode_key" ON "Profile"("referralCode");

-- CreateIndex
CREATE INDEX "Profile_userId_idx" ON "Profile"("userId");

-- CreateIndex
CREATE INDEX "Profile_companyUserId_idx" ON "Profile"("companyUserId");

-- CreateIndex
CREATE INDEX "Profile_slug_idx" ON "Profile"("slug");

-- CreateIndex
CREATE INDEX "Profile_isPublic_idx" ON "Profile"("isPublic");

-- CreateIndex
CREATE UNIQUE INDEX "Address_legacyId_key" ON "Address"("legacyId");

-- CreateIndex
CREATE INDEX "Address_profileId_idx" ON "Address"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Education_legacyId_key" ON "Education"("legacyId");

-- CreateIndex
CREATE INDEX "Education_profileId_idx" ON "Education"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Experience_legacyId_key" ON "Experience"("legacyId");

-- CreateIndex
CREATE INDEX "Experience_profileId_idx" ON "Experience"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillType_legacyId_key" ON "SkillType"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillType_name_key" ON "SkillType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SkillTag_legacyId_key" ON "SkillTag"("legacyId");

-- CreateIndex
CREATE INDEX "SkillTag_profileId_idx" ON "SkillTag"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_legacyId_key" ON "Service"("legacyId");

-- CreateIndex
CREATE INDEX "Service_profileId_idx" ON "Service"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Portfolio_legacyId_key" ON "Portfolio"("legacyId");

-- CreateIndex
CREATE INDEX "Portfolio_profileId_idx" ON "Portfolio"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "PostType_legacyId_key" ON "PostType"("legacyId");

-- CreateIndex
CREATE INDEX "PostType_name_idx" ON "PostType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Post_legacyId_key" ON "Post"("legacyId");

-- CreateIndex
CREATE INDEX "Post_profileId_idx" ON "Post"("profileId");

-- CreateIndex
CREATE INDEX "Post_postTypeId_idx" ON "Post"("postTypeId");

-- CreateIndex
CREATE INDEX "Post_status_idx" ON "Post"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PostMeta_legacyId_key" ON "PostMeta"("legacyId");

-- CreateIndex
CREATE INDEX "PostMeta_postId_idx" ON "PostMeta"("postId");

-- CreateIndex
CREATE INDEX "PostMeta_metaKey_idx" ON "PostMeta"("metaKey");

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentType_legacyId_key" ON "AttachmentType"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_legacyId_key" ON "Attachment"("legacyId");

-- CreateIndex
CREATE INDEX "Attachment_attachableType_attachableId_idx" ON "Attachment"("attachableType", "attachableId");

-- CreateIndex
CREATE INDEX "Attachment_profileId_idx" ON "Attachment"("profileId");

-- CreateIndex
CREATE INDEX "Attachment_postId_idx" ON "Attachment"("postId");

-- CreateIndex
CREATE INDEX "Attachment_attachmentTypeId_idx" ON "Attachment"("attachmentTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_legacyId_key" ON "Setting"("legacyId");

-- CreateIndex
CREATE INDEX "Setting_profileId_idx" ON "Setting"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_profileId_key_key" ON "Setting"("profileId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileSetting_legacyId_key" ON "ProfileSetting"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileSetting_profileId_key" ON "ProfileSetting"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialLink_legacyId_key" ON "SocialLink"("legacyId");

-- CreateIndex
CREATE INDEX "SocialLink_profileId_idx" ON "SocialLink"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Menu_legacyId_key" ON "Menu"("legacyId");

-- CreateIndex
CREATE INDEX "Menu_profileId_idx" ON "Menu"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_legacyId_key" ON "MenuItem"("legacyId");

-- CreateIndex
CREATE INDEX "MenuItem_menuId_idx" ON "MenuItem"("menuId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_legacyId_key" ON "Contact"("legacyId");

-- CreateIndex
CREATE INDEX "Contact_profileId_idx" ON "Contact"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestUserData_legacyId_key" ON "GuestUserData"("legacyId");

-- CreateIndex
CREATE INDEX "GuestUserData_profileId_idx" ON "GuestUserData"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "UserNote_legacyId_key" ON "UserNote"("legacyId");

-- CreateIndex
CREATE INDEX "UserNote_profileId_idx" ON "UserNote"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "EventLog_legacyId_key" ON "EventLog"("legacyId");

-- CreateIndex
CREATE INDEX "EventLog_profileId_idx" ON "EventLog"("profileId");

-- CreateIndex
CREATE INDEX "EventLog_eventType_idx" ON "EventLog"("eventType");

-- CreateIndex
CREATE INDEX "EventLog_createdAt_idx" ON "EventLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_legacyId_key" ON "PushSubscription"("legacyId");

-- CreateIndex
CREATE INDEX "PushSubscription_profileId_idx" ON "PushSubscription"("profileId");

-- CreateIndex
CREATE INDEX "PushSubscription_endpointHash_idx" ON "PushSubscription"("endpointHash");

-- CreateIndex
CREATE UNIQUE INDEX "PushNotificationPreference_legacyId_key" ON "PushNotificationPreference"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "PushNotificationPreference_pushSubscriptionId_key" ON "PushNotificationPreference"("pushSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Package_legacyId_key" ON "Package"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Package_slug_key" ON "Package"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PackageFeature_legacyId_key" ON "PackageFeature"("legacyId");

-- CreateIndex
CREATE INDEX "PackageFeature_packageId_idx" ON "PackageFeature"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "PackageFeature_packageId_featureKey_key" ON "PackageFeature"("packageId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_legacyId_key" ON "Subscription"("legacyId");

-- CreateIndex
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "Subscription_packageId_idx" ON "Subscription"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionItem_legacyId_key" ON "SubscriptionItem"("legacyId");

-- CreateIndex
CREATE INDEX "SubscriptionItem_subscriptionId_idx" ON "SubscriptionItem"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_legacyId_key" ON "Transaction"("legacyId");

-- CreateIndex
CREATE INDEX "Transaction_userId_idx" ON "Transaction"("userId");

-- CreateIndex
CREATE INDEX "Transaction_subscriptionId_idx" ON "Transaction"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEmployee_legacyId_key" ON "CompanyEmployee"("legacyId");

-- CreateIndex
CREATE INDEX "CompanyEmployee_companyId_idx" ON "CompanyEmployee"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEmployee_userId_companyId_key" ON "CompanyEmployee"("userId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "User_legacyId_key" ON "User"("legacyId");

-- AddForeignKey
ALTER TABLE "State" ADD CONSTRAINT "State_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_companyUserId_fkey" FOREIGN KEY ("companyUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_genderId_fkey" FOREIGN KEY ("genderId") REFERENCES "Gender"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_maritalStatusId_fkey" FOREIGN KEY ("maritalStatusId") REFERENCES "MaritalStatus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_professionId_fkey" FOREIGN KEY ("professionId") REFERENCES "Profession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillTag" ADD CONSTRAINT "SkillTag_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillTag" ADD CONSTRAINT "SkillTag_skillTypeId_fkey" FOREIGN KEY ("skillTypeId") REFERENCES "SkillType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Portfolio" ADD CONSTRAINT "Portfolio_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_postTypeId_fkey" FOREIGN KEY ("postTypeId") REFERENCES "PostType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMeta" ADD CONSTRAINT "PostMeta_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_attachmentTypeId_fkey" FOREIGN KEY ("attachmentTypeId") REFERENCES "AttachmentType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileSetting" ADD CONSTRAINT "ProfileSetting_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialLink" ADD CONSTRAINT "SocialLink_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Menu" ADD CONSTRAINT "Menu_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestUserData" ADD CONSTRAINT "GuestUserData_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNote" ADD CONSTRAINT "UserNote_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushNotificationPreference" ADD CONSTRAINT "PushNotificationPreference_pushSubscriptionId_fkey" FOREIGN KEY ("pushSubscriptionId") REFERENCES "PushSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageFeature" ADD CONSTRAINT "PackageFeature_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyEmployee" ADD CONSTRAINT "CompanyEmployee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyEmployee" ADD CONSTRAINT "CompanyEmployee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
