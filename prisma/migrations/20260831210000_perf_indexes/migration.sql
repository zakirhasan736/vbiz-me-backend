-- Performance indexes for hot list/public-card query paths
CREATE INDEX IF NOT EXISTS "Profile_statusId_idx" ON "Profile"("statusId");
CREATE INDEX IF NOT EXISTS "Profile_createdById_idx" ON "Profile"("createdById");
CREATE INDEX IF NOT EXISTS "Profile_professionId_idx" ON "Profile"("professionId");
CREATE INDEX IF NOT EXISTS "Profile_updatedAt_idx" ON "Profile"("updatedAt");
CREATE INDEX IF NOT EXISTS "Profile_createdAt_idx" ON "Profile"("createdAt");
CREATE INDEX IF NOT EXISTS "Profile_isPublic_isDraft_updatedAt_idx" ON "Profile"("isPublic", "isDraft", "updatedAt");
CREATE INDEX IF NOT EXISTS "Profile_professionId_isPublic_isDraft_idx" ON "Profile"("professionId", "isPublic", "isDraft");

CREATE INDEX IF NOT EXISTS "Address_profileId_isPrimary_idx" ON "Address"("profileId", "isPrimary");

CREATE INDEX IF NOT EXISTS "BlogDirect_profileId_deletedAt_status_idx" ON "BlogDirect"("profileId", "deletedAt", "status");

CREATE INDEX IF NOT EXISTS "TabItem_profileId_tabKey_deletedAt_status_idx" ON "TabItem"("profileId", "tabKey", "deletedAt", "status");

CREATE INDEX IF NOT EXISTS "PostMeta_postId_metaKey_idx" ON "PostMeta"("postId", "metaKey");

CREATE INDEX IF NOT EXISTS "User_createdById_idx" ON "User"("createdById");
CREATE INDEX IF NOT EXISTS "User_role_idx" ON "User"("role");

-- JSON guestId / channel lookups in analytics (payload->>'guestId')
CREATE INDEX IF NOT EXISTS "EventLog_payload_gin_idx" ON "EventLog" USING GIN ("payload" jsonb_path_ops);
