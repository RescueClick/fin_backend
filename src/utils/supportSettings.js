import { Config } from "../models/Config.js";

export const DEFAULT_SUPPORT_SETTINGS = {
  phone: "+917057772026",
  email: "support@dhansourcecapital.com",
  whatsapp: "+917057772026",
  hours: "Mon - Sat: 9:30 AM - 6:30 PM",
};

/**
 * Get current system support settings from Config model or fallback to defaults
 */
export async function getSupportSettings() {
  try {
    const doc = await Config.findOne({ key: "SUPPORT_SETTINGS" }).lean();
    if (doc?.value) {
      return {
        phone: String(doc.value.phone || DEFAULT_SUPPORT_SETTINGS.phone).trim(),
        email: String(doc.value.email || DEFAULT_SUPPORT_SETTINGS.email).trim().toLowerCase(),
        whatsapp: String(doc.value.whatsapp || doc.value.phone || DEFAULT_SUPPORT_SETTINGS.whatsapp).trim(),
        hours: String(doc.value.hours || DEFAULT_SUPPORT_SETTINGS.hours).trim(),
        updatedAt: doc.updatedAt || doc.createdAt || null,
      };
    }
  } catch (err) {
    console.error("Error fetching SUPPORT_SETTINGS config:", err);
  }

  return {
    ...DEFAULT_SUPPORT_SETTINGS,
    updatedAt: null,
  };
}

/**
 * Save updated support settings
 */
export async function saveSupportSettings({ phone, email, whatsapp, hours }) {
  const current = await getSupportSettings();

  const cleanPhone = phone !== undefined && phone !== null
    ? String(phone).trim()
    : current.phone;

  const cleanEmail = email !== undefined && email !== null
    ? String(email).trim().toLowerCase()
    : current.email;

  const cleanWhatsapp = whatsapp !== undefined && whatsapp !== null
    ? String(whatsapp).trim()
    : (cleanPhone || current.whatsapp);

  const cleanHours = hours !== undefined && hours !== null
    ? String(hours).trim()
    : current.hours;

  if (!cleanPhone) {
    throw new Error("Support contact phone number is required");
  }

  const digitsOnly = cleanPhone.replace(/\D/g, "");
  if (digitsOnly.length < 8) {
    throw new Error("Support phone number must contain at least 8 digits");
  }

  const payload = {
    phone: cleanPhone,
    email: cleanEmail,
    whatsapp: cleanWhatsapp,
    hours: cleanHours,
  };

  const updatedDoc = await Config.findOneAndUpdate(
    { key: "SUPPORT_SETTINGS" },
    { $set: { value: payload } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    phone: payload.phone,
    email: payload.email,
    whatsapp: payload.whatsapp,
    hours: payload.hours,
    updatedAt: updatedDoc.updatedAt || new Date(),
  };
}
