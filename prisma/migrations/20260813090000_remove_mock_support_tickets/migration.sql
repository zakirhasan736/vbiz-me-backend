DELETE FROM "SupportTicket"
WHERE "createdById" IS NULL
  AND ("fromEmail", "subject") IN (
    ('amina@northstar.co', 'Love the new card templates'),
    ('jordan.lee@example.com', 'QR code not scanning on Android'),
    ('priya@brightpath.io', 'How do I invite team members?'),
    ('marcus.chen@gmail.com', 'Request: analytics export to CSV'),
    ('elena@orbitlabs.com', 'Billing receipt missing'),
    ('sam@okonkwo.design', 'Custom domain setup stuck'),
    ('chris@helixgroup.com', 'Team card branding colors reset'),
    ('fatima@crescent.media', 'Thank you for onboarding help')
  );
