-- Wish & outreach: snapshot of CRM lead (guest) recipients for scheduled delivery.
ALTER TABLE "CrmEvent" ADD COLUMN IF NOT EXISTS "recipientLeadIds" JSONB;
