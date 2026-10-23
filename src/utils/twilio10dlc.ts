import config from '../configs/config'

/**
 * 10DLC (A2P) business registration for US application-to-person SMS.
 *
 * vBiz Me sends owner alert SMS through Twilio. Carrier delivery in the US
 * requires a registered Brand + Campaign on a Messaging Service. That
 * registration is done in Twilio Console / Trust Hub (legal business docs,
 * campaign use-case, sample messages, opt-out language). This backend does
 * not file Brand/Campaign applications automatically — it only reads the
 * configured SIDs so ops can confirm the Messaging Service is 10DLC-ready.
 *
 * Required ops steps (Twilio):
 * 1. Create Customer Profile + Brand Registration (EIN / business details).
 * 2. Create A2P Campaign (use-case: Account Notifications / Customer Care).
 * 3. Attach the Campaign to the Messaging Service used by TWILIO_MESSAGING_SERVICE_SID.
 * 4. Keep STOP / HELP language in every message (see buildVbizSms).
 */
export type Twilio10DlcStatus = {
  messagingServiceConfigured: boolean
  messagingServiceSid: string | null
  brandSid: string | null
  campaignSid: string | null
  readyForUsTraffic: boolean
  notes: string[]
}

export function getTwilio10DlcStatus(): Twilio10DlcStatus {
  const messagingServiceSid = config.TWILIO.MESSAGING_SERVICE_SID || null
  const brandSid = config.TWILIO.BRAND_SID || null
  const campaignSid = config.TWILIO.CAMPAIGN_SID || null
  const notes: string[] = []

  if (!messagingServiceSid) {
    notes.push('Set TWILIO_MESSAGING_SERVICE_SID to the 10DLC-linked Messaging Service.')
  }
  if (!brandSid) {
    notes.push('Set TWILIO_10DLC_BRAND_SID after Brand Registration is approved in Twilio Trust Hub.')
  }
  if (!campaignSid) {
    notes.push('Set TWILIO_10DLC_CAMPAIGN_SID after the A2P Campaign is approved and attached.')
  }
  if (messagingServiceSid && brandSid && campaignSid) {
    notes.push('SIDs present — confirm Campaign is attached to the Messaging Service in Twilio Console.')
  }

  return {
    messagingServiceConfigured: Boolean(messagingServiceSid),
    messagingServiceSid,
    brandSid,
    campaignSid,
    readyForUsTraffic: Boolean(messagingServiceSid && brandSid && campaignSid),
    notes,
  }
}
