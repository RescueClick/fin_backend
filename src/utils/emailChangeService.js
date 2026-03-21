import crypto from "crypto";
import { User } from "../models/User.js";
import { sendMail } from "./sendMail.js";
import { COMPANY_NAME, getClientBaseUrl } from "../config/branding.js";

/**
 * Sends confirmation link to new email; stores token on user (email not switched until confirm).
 */
export async function createEmailChangeRequest({ user, newEmail, clientUrl }) {
  if (!user?._id || !newEmail) {
    throw new Error("createEmailChangeRequest: user and newEmail required");
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await User.findByIdAndUpdate(user._id, {
    $set: {
      pendingEmail: String(newEmail).toLowerCase().trim(),
      emailChangeToken: token,
      emailChangeTokenExpires: expires,
    },
  });

  const base = String(clientUrl || getClientBaseUrl()).replace(/\/$/, "");
  const link = `${base}/email-change/confirm?token=${encodeURIComponent(token)}`;

  try {
    await sendMail({
      to: newEmail,
      subject: `Confirm your new email address — ${COMPANY_NAME}`,
      html: `
        <p>Hi${user.firstName ? ` ${user.firstName}` : ""},</p>
        <p>Click the link below to confirm this email as your new login email:</p>
        <p><a href="${link}">${link}</a></p>
        <p>If you did not request this, ignore this email.</p>
      `,
    });
  } catch (err) {
    console.error("createEmailChangeRequest: sendMail failed", err);
    throw err;
  }
}
