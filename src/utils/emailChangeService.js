import crypto from "crypto";
import { User } from "../models/User.js";
import { sendMail } from "./sendMail.js";
import { COMPANY_NAME, getClientBaseUrl } from "../config/branding.js";

/**
 * Dual verification flow:
 * - send one link to current(active) email
 * - send one link to new email
 * Email is switched only when both links are verified.
 */
export async function createEmailChangeRequest({ user, newEmail, currentEmail, clientUrl }) {
  if (!user?._id || !newEmail) {
    throw new Error("createEmailChangeRequest: user and newEmail required");
  }

  const tokenOld = crypto.randomBytes(32).toString("hex");
  const tokenNew = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  const activeEmail = String(currentEmail || user.email || "").toLowerCase().trim();
  const targetEmail = String(newEmail).toLowerCase().trim();

  await User.findByIdAndUpdate(user._id, {
    $set: {
      pendingEmail: targetEmail,
      emailChangeToken: tokenNew, // legacy compatibility
      emailChangeTokenOld: tokenOld,
      emailChangeTokenNew: tokenNew,
      emailChangeOldVerified: false,
      emailChangeNewVerified: false,
      emailChangeTokenExpires: expires,
    },
  });

  const base = String(clientUrl || getClientBaseUrl()).replace(/\/$/, "");
  const oldLink = `${base}/email-change/confirm?token=${encodeURIComponent(tokenOld)}`;
  const newLink = `${base}/email-change/confirm?token=${encodeURIComponent(tokenNew)}`;

  try {
    if (activeEmail) {
      await sendMail({
        to: activeEmail,
        subject: `Approve email change request — ${COMPANY_NAME}`,
        html: `
          <p>Hi${user.firstName ? ` ${user.firstName}` : ""},</p>
          <p>We received a request to change your login email to <b>${targetEmail}</b>.</p>
          <p>Approve this request by clicking below:</p>
          <p><a href="${oldLink}">${oldLink}</a></p>
          <p>If you did not request this, ignore this email and secure your account.</p>
        `,
      });
    }

    await sendMail({
      to: targetEmail,
      subject: `Verify your new email address — ${COMPANY_NAME}`,
      html: `
        <p>Hi${user.firstName ? ` ${user.firstName}` : ""},</p>
        <p>Please verify this email as your new login email address:</p>
        <p><a href="${newLink}">${newLink}</a></p>
        <p>For security, the change completes only after approval from your current email.</p>
      `,
    });
  } catch (err) {
    console.error("createEmailChangeRequest: sendMail failed", err);
    throw err;
  }
}
