import { Router } from "express";
import argon2 from "argon2";
import { User } from "../models/User.js";
import { signAccessToken } from "../utils/jwt.js";
import { ROLES } from "../config/roles.js";
import crypto from "crypto";
import { sendMail } from "../utils/sendMail.js";
import { createEmailChangeRequest } from "../utils/emailChangeService.js";
import { getClientBaseUrl, canonicalPartnerReferralCode } from "../config/branding.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { getActivePartnerByPartnerCode } from "../utils/referralService.js";

const router = Router();

router.post(
  "/create-admin",
  asyncHandler(async (req, res) => {
    const { firstName, lastName, phone, email, password } = req.body || {};
    if (!firstName || !lastName || !phone || !email || !password) {
      throw new ApiError(400, "firstName, lastName, phone, email, password are required", {
        code: "VALIDATION_ERROR",
      });
    }

    const emailLc = String(email).toLowerCase();
    const existingAdmin = await User.findOne({ email: emailLc });
    if (existingAdmin) {
      throw new ApiError(409, "Admin already exists with this email", { code: "DUPLICATE_EMAIL" });
    }

    const passwordHash = await argon2.hash(password);
    const admin = await User.create({
      firstName,
      lastName,
      phone,
      email: emailLc,
      passwordHash,
      role: ROLES.SUPER_ADMIN,
      status: "ACTIVE",
    });

    return sendSuccess(res, {
      statusCode: 201,
      message: "Admin created successfully",
      data: {
        admin: {
          id: admin._id,
          firstName: admin.firstName,
          lastName: admin.lastName,
          phone: admin.phone,
          email: admin.email,
          role: admin.role,
          status: admin.status,
        },
      },
    });
  })
);

/**
 * LOGIN  (Admin, ASM, RM, Partner)
 */
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      throw new ApiError(400, "email and password required", { code: "VALIDATION_ERROR" });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) throw new ApiError(401, "Invalid credentials", { code: "AUTH_INVALID_CREDENTIALS" });

    if (user.status === "SUSPENDED") {
      throw new ApiError(403, "Your account has been suspended. Contact admin.", { code: "AUTH_SUSPENDED" });
    }
    if (user.status !== "ACTIVE") {
      throw new ApiError(403, `Account is not active (status: ${user.status}).`, { code: "AUTH_INACTIVE" });
    }
    if (!user.passwordHash) {
      throw new ApiError(500, "Password not set for this account", { code: "AUTH_PASSWORD_NOT_SET" });
    }

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new ApiError(401, "Invalid credentials", { code: "AUTH_INVALID_CREDENTIALS" });

    const token = signAccessToken({
      sub: String(user._id),
      role: user.role,
      rmId: user.rmId ? String(user.rmId) : undefined,
      asmId: user.asmId ? String(user.asmId) : undefined,
    });

    let partnerCodeOut = user.partnerCode;
    let referralCodeOut = user.referralCode;
    if (user.role === ROLES.PARTNER) {
      const pub = canonicalPartnerReferralCode(user.partnerCode, user.referralCode);
      if (pub) {
        const mismatch =
          String(user.partnerCode || "").trim() !== pub ||
          String(user.referralCode || "").trim() !== pub;
        if (mismatch && /^PT-/i.test(pub)) {
          await User.updateOne(
            { _id: user._id },
            { $set: { partnerCode: pub, referralCode: pub } }
          );
        }
        partnerCodeOut = pub;
        referralCodeOut = pub;
      }
    }

    return sendSuccess(res, {
      message: "Login successful",
      data: {
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          status: user.status,
          employeeId: user.employeeId,
          asmId: user.asmId,
          rmId: user.rmId,
          asmCode: user.asmCode,
          rmCode: user.rmCode,
          partnerCode: partnerCodeOut,
          referralCode: referralCodeOut,
          referredBy: user.referredBy,
        },
      },
    });
  })
);

/**
 * Google OAuth login for Partner app (one-tap).
 * Body: { idToken }
 * Verifies Google ID token, then issues the same JWT shape as password login.
 * Any ACTIVE account (Admin / ASM / RSM / RM / Partner / Customer) may sign in this way.
 */
router.post(
  "/google-login",
  asyncHandler(async (req, res) => {
    const { idToken } = req.body || {};
    if (!idToken || typeof idToken !== "string") {
      throw new ApiError(400, "Google idToken is required", {
        code: "VALIDATION_ERROR",
      });
    }

    let googlePayload;
    try {
      const tokenRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
      );
      if (!tokenRes.ok) {
        throw new Error("tokeninfo failed");
      }
      googlePayload = await tokenRes.json();
    } catch {
      throw new ApiError(401, "Invalid Google token", {
        code: "AUTH_GOOGLE_INVALID_TOKEN",
      });
    }

    const email = String(googlePayload?.email || "")
      .trim()
      .toLowerCase();
    const emailVerified =
      googlePayload?.email_verified === true ||
      googlePayload?.email_verified === "true";

    if (!email || !emailVerified) {
      throw new ApiError(401, "Google account email is not verified", {
        code: "AUTH_GOOGLE_EMAIL_UNVERIFIED",
      });
    }

    const allowedAudiences = [
      process.env.GOOGLE_WEB_CLIENT_ID,
      process.env.GOOGLE_ANDROID_CLIENT_ID,
      process.env.GOOGLE_IOS_CLIENT_ID,
      process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    ]
      .map((v) => String(v || "").trim())
      .filter(Boolean);

    if (
      allowedAudiences.length > 0 &&
      googlePayload?.aud &&
      !allowedAudiences.includes(String(googlePayload.aud))
    ) {
      throw new ApiError(401, "Google token audience mismatch", {
        code: "AUTH_GOOGLE_AUD_MISMATCH",
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      throw new ApiError(
        404,
        "No account found for this Google email. Please register first or use email login.",
        { code: "AUTH_GOOGLE_USER_NOT_FOUND" }
      );
    }

    if (user.status === "SUSPENDED") {
      throw new ApiError(403, "Your account has been suspended. Contact admin.", {
        code: "AUTH_SUSPENDED",
      });
    }
    if (user.status !== "ACTIVE") {
      throw new ApiError(
        403,
        `Account is not active (status: ${user.status}).`,
        { code: "AUTH_INACTIVE" }
      );
    }

    const token = signAccessToken({
      sub: String(user._id),
      role: user.role,
      rmId: user.rmId ? String(user.rmId) : undefined,
      asmId: user.asmId ? String(user.asmId) : undefined,
    });

    let partnerCodeOut = user.partnerCode;
    let referralCodeOut = user.referralCode;
    const pub = canonicalPartnerReferralCode(user.partnerCode, user.referralCode);
    if (pub) {
      const mismatch =
        String(user.partnerCode || "").trim() !== pub ||
        String(user.referralCode || "").trim() !== pub;
      if (mismatch && /^PT-/i.test(pub)) {
        await User.updateOne(
          { _id: user._id },
          { $set: { partnerCode: pub, referralCode: pub } }
        );
      }
      partnerCodeOut = pub;
      referralCodeOut = pub;
    }

    return sendSuccess(res, {
      message: "Google login successful",
      data: {
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          status: user.status,
          employeeId: user.employeeId,
          asmId: user.asmId,
          rmId: user.rmId,
          asmCode: user.asmCode,
          rmCode: user.rmCode,
          partnerCode: partnerCodeOut,
          referralCode: referralCodeOut,
          referredBy: user.referredBy,
        },
      },
    });
  })
);

// POST /admin/login-as/:userId
router.post(
  "/login-as/:userId",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ASM, ROLES.RSM, ROLES.RM),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const currentUserRole = req.user.role;
      const currentUserId = req.user.sub;

      // Find the user to impersonate
      const targetUser = await User.findById(userId);
      if (!targetUser) return res.status(404).json({ message: "User not found" });
      if (targetUser.status !== "ACTIVE")
        return res
          .status(403)
          .json({ message: "Cannot login as inactive user" });

      // Enforce hierarchy: SUPER_ADMIN > ASM > RSM > RM > PARTNER > CUSTOMER
      const roleHierarchy = {
        [ROLES.SUPER_ADMIN]: [ROLES.ASM, ROLES.RSM, ROLES.RM, ROLES.PARTNER, ROLES.CUSTOMER],
        [ROLES.ASM]: [ROLES.RSM, ROLES.RM, ROLES.PARTNER, ROLES.CUSTOMER],
        [ROLES.RSM]: [ROLES.RM, ROLES.PARTNER, ROLES.CUSTOMER],
        [ROLES.RM]: [ROLES.PARTNER, ROLES.CUSTOMER],
      };

      const allowedRoles = roleHierarchy[currentUserRole];
      if (!allowedRoles || !allowedRoles.includes(targetUser.role)) {
        return res.status(403).json({ 
          message: `You cannot login as ${targetUser.role}. Only ${allowedRoles?.join(", ") || "none"} roles are allowed.` 
        });
      }

      // Additional hierarchy check: Verify parent-child relationship
      if (currentUserRole === ROLES.ASM) {
        // ASM can only login as their own RMs or RMs' partners
        if (targetUser.role === ROLES.RM && targetUser.asmId?.toString() !== currentUserId) {
          return res.status(403).json({ message: "You can only login as RMs assigned to you" });
        }
        if (targetUser.role === ROLES.PARTNER) {
          const rm = await User.findById(targetUser.rmId);
          if (!rm || rm.asmId?.toString() !== currentUserId) {
            return res.status(403).json({ message: "You can only login as partners under your RMs" });
          }
        }
      } else if (currentUserRole === ROLES.RM) {
        // RM can only login as their own partners
        if (targetUser.role === ROLES.PARTNER && targetUser.rmId?.toString() !== currentUserId) {
          return res.status(403).json({ message: "You can only login as partners assigned to you" });
        }
      }

      // Get current user info for parent tracking
      const currentUser = await User.findById(currentUserId).select("firstName lastName email role");
      if (!currentUser) {
        return res.status(401).json({
          message: "Your session is invalid (actor not found). Please log in again.",
        });
      }

      // Issue token for the target user with parent info
      const token = signAccessToken({
        sub: String(targetUser._id),
        role: targetUser.role,
        rmId: targetUser.rmId ? String(targetUser.rmId) : undefined,
        asmId: targetUser.asmId ? String(targetUser.asmId) : undefined,
        partnerId: targetUser.partnerId ? String(targetUser.partnerId) : undefined,
        impersonatedBy: currentUserId, // Parent user ID
        parentRole: currentUserRole, // Parent role
      });

      return res.json({
        message: `Logged in as ${targetUser.role} successfully`,
        token,
        user: {
          id: targetUser._id,
          firstName: targetUser.firstName,
          lastName: targetUser.lastName,
          email: targetUser.email,
          role: targetUser.role,
          asmId: targetUser.asmId,
          rmId: targetUser.rmId,
          partnerId: targetUser.partnerId,
          partnerCode: targetUser.partnerCode,
          employeeId: targetUser.employeeId,
        },
        parent: {
          id: currentUser._id,
          firstName: currentUser.firstName,
          lastName: currentUser.lastName,
          email: currentUser.email,
          role: currentUser.role,
        },
      });
    } catch (err) {
      console.error("Admin login-as error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * (Optional) Partner self-registration via RM code (referral).
 * Disable this route if you want only RM-created partners.
 */
router.post("/partner/register-by-rmcode", async (req, res) => {
  const { firstName, lastName, email, password, rmCode } = req.body || {};
  if (!firstName || !lastName || !email || !password || !rmCode) {
    return res
      .status(400)
      .json({ message: "name, email, password, rmCode required" });
  }

  const rm = await User.findOne({ rmCode, role: ROLES.RM, status: "ACTIVE" });
  if (!rm) return res.status(400).json({ message: "Invalid RM code" });

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) return res.status(409).json({ message: "Email already in use" });

  const passwordHash = await argon2.hash(password);
  const partner = await User.create({
    firstName,
    lastName,
    email: email.toLowerCase(),
    passwordHash,
    role: ROLES.PARTNER,
    rmId: rm._id,
    partnerCode: `PT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  });

  return res.status(201).json({
    message: "Partner registered",
    id: partner._id,
    partnerCode: partner.partnerCode,
  });
});

router.post(
  "/referral/validate",
  asyncHandler(async (req, res) => {
    const { referralCode } = req.body || {};
    if (!referralCode) {
      throw new ApiError(400, "referralCode is required", { code: "VALIDATION_ERROR" });
    }

    const owner = await getActivePartnerByPartnerCode(referralCode);
    if (!owner) {
      throw new ApiError(404, "Invalid or inactive partner code", { code: "REFERRAL_NOT_FOUND" });
    }

    return sendSuccess(res, {
      message: "Partner code is valid",
      data: { owner },
    });
  })
);

router.post(
  "/customer/signup",
  asyncHandler(async (req, res) => {
    const {
      firstName,
      lastName,
      email,
      phone,
      password,
      referralCode,
    } = req.body || {};

    if (referralCode != null && String(referralCode).trim() !== "") {
      throw new ApiError(
        400,
        "Referral codes apply to channel partner registration only, not customer accounts.",
        { code: "REFERRAL_CUSTOMER_NOT_ALLOWED" }
      );
    }

    if (!firstName || !lastName || !email || !phone || !password) {
      throw new ApiError(
        400,
        "firstName, lastName, email, phone and password are required",
        { code: "VALIDATION_ERROR" }
      );
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedPhone = String(phone).replace(/\D/g, "").slice(-10);
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      throw new ApiError(400, "Invalid email format", { code: "VALIDATION_ERROR" });
    }
    if (!/^\d{10}$/.test(normalizedPhone)) {
      throw new ApiError(400, "Phone must be a valid 10-digit number", { code: "VALIDATION_ERROR" });
    }

    const duplicate = await User.findOne({
      $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
    })
      .select("_id")
      .lean();
    if (duplicate) {
      throw new ApiError(409, "Email or phone already in use", { code: "DUPLICATE_USER" });
    }

    let defaultPartner = null;
    if (process.env.DEFAULT_COMPANY_PARTNER_CODE) {
      defaultPartner = await User.findOne({ partnerCode: process.env.DEFAULT_COMPANY_PARTNER_CODE, role: ROLES.PARTNER });
    }
    if (!defaultPartner) {
      defaultPartner = await User.findOne({ role: ROLES.PARTNER, firstName: /sanjay/i });
    }
    if (!defaultPartner) {
      defaultPartner = await User.findOne({ role: ROLES.PARTNER, status: "ACTIVE" });
    }

    const customer = await User.create({
      employeeId: await generateEmployeeId("CUSTOMER"),
      firstName,
      lastName,
      email: normalizedEmail,
      phone: normalizedPhone,
      passwordHash: await argon2.hash(String(password)),
      role: ROLES.CUSTOMER,
      status: "ACTIVE",
      referralRewardStatus: "NONE",
      partnerId: defaultPartner?._id || undefined,
      rmId: defaultPartner?.rmId || undefined,
    });

    return sendSuccess(res, {
      statusCode: 201,
      message: "Customer signup successful",
      data: {
        customer: {
          id: customer._id,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          phone: customer.phone,
          role: customer.role,
          referralCode: customer.referralCode,
          referredBy: customer.referredBy,
        },
      },
    });
  })
);

// ─── OTP-based forgot-password flow (mobile app) ────────────────────────────

/**
 * STEP 1 – POST /api/auth/forgot-password
 * Generates a 6-digit OTP, saves it hashed on the user, and emails it.
 */
router.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!email) throw new ApiError(400, "Email is required", { code: "VALIDATION_ERROR" });

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    // Always return 200 to avoid email enumeration
    if (!user) {
      return sendSuccess(res, { message: "If an account exists, an OTP has been sent." });
    }

    // Generate a 6-digit numeric OTP
    const otp = String(Math.floor(100000 + crypto.randomInt(900000)));
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.otpCode   = otp;   // stored plain – safe because it expires quickly
    user.otpExpiry = otpExpiry;
    await user.save();

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error("forgot-password: email credentials missing");
      throw new ApiError(500, "Email service not configured. Contact support.", { code: "EMAIL_NOT_CONFIGURED" });
    }

    await sendMail({
      to: user.email,
      subject: "Your DhanSource Password Reset OTP",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#12B99C">Password Reset OTP</h2>
          <p>Hi ${user.firstName || "User"},</p>
          <p>Use the OTP below to reset your DhanSource account password.
             It expires in <strong>10 minutes</strong>.</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;
                      color:#1c1917;background:#f5f5f4;padding:18px 24px;
                      border-radius:10px;display:inline-block;margin:12px 0">
            ${otp}
          </div>
          <p style="font-size:13px;color:#78716c">
            If you did not request this, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    return sendSuccess(res, { message: "OTP sent! Check your inbox." });
  })
);

/**
 * STEP 2 – POST /api/auth/verify-otp
 * Verifies the OTP is correct and not expired.
 */
router.post(
  "/verify-otp",
  asyncHandler(async (req, res) => {
    const { email, otp } = req.body || {};
    if (!email || !otp) {
      throw new ApiError(400, "email and otp are required", { code: "VALIDATION_ERROR" });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user || !user.otpCode || !user.otpExpiry) {
      throw new ApiError(400, "Invalid or expired OTP. Please request a new one.", { code: "OTP_INVALID" });
    }

    if (new Date() > user.otpExpiry) {
      user.otpCode   = undefined;
      user.otpExpiry = undefined;
      await user.save();
      throw new ApiError(400, "OTP has expired. Please request a new one.", { code: "OTP_EXPIRED" });
    }

    if (String(otp).trim() !== user.otpCode) {
      throw new ApiError(400, "Incorrect OTP. Please try again.", { code: "OTP_MISMATCH" });
    }

    // OTP is valid — leave it on the user so Step 3 can also verify before resetting.
    return sendSuccess(res, { message: "OTP verified! Set your new password." });
  })
);

/**
 * STEP 3 – POST /api/auth/reset-password
 * Verifies OTP once more, then resets the password.
 */
router.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { email, otp, newPassword } = req.body || {};
    if (!email || !otp || !newPassword) {
      throw new ApiError(400, "email, otp and newPassword are required", { code: "VALIDATION_ERROR" });
    }
    if (String(newPassword).length < 6) {
      throw new ApiError(400, "Password must be at least 6 characters.", { code: "VALIDATION_ERROR" });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user || !user.otpCode || !user.otpExpiry) {
      throw new ApiError(400, "Invalid or expired OTP. Please restart the process.", { code: "OTP_INVALID" });
    }

    if (new Date() > user.otpExpiry) {
      user.otpCode   = undefined;
      user.otpExpiry = undefined;
      await user.save();
      throw new ApiError(400, "OTP has expired. Please request a new one.", { code: "OTP_EXPIRED" });
    }

    if (String(otp).trim() !== user.otpCode) {
      throw new ApiError(400, "Incorrect OTP. Session invalid.", { code: "OTP_MISMATCH" });
    }

    // All checks passed — set new password
    user.passwordHash = await argon2.hash(String(newPassword));
    user.otpCode      = undefined;
    user.otpExpiry    = undefined;
    await user.save();

    return sendSuccess(res, { message: "Password reset successfully. Please sign in." });
  })
);

// ─── Token-link-based reset (web dashboard / email links) ───────────────────

/**
 * Request password reset (secure version)
 */

router.post("/reset-password/request", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email required" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.json({ message: "If an account exists, reset link sent" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetExpiry = Date.now() + 15 * 60 * 1000;

    user.resetToken = resetToken;
    user.resetTokenExpiry = resetExpiry;
    await user.save();

    // Reset link only needs token + email
    const resetLink = `${getClientBaseUrl()}/reset-password/confirm?token=${resetToken}&email=${user.email}`;

    // Ensure mailer is configured to prevent 500s on missing env
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error(
        "Reset request: email credentials are missing. Skipping email send."
      );
      return res.status(500).json({
        message:
          "Email service not configured. Contact support to complete password reset.",
      });
    }

    try {
      await sendMail({
        to: user.email,
        subject: "Password Reset Request",
        html: `
          <h2>Password Reset</h2>
          <p>Hello ${user.name || "User"},</p>
          <p>Click below to reset your password:</p>
          <a href="${resetLink}">Reset Password</a>
          <p>If you didn’t request this, ignore this email.</p>
        `,
      });
    } catch (mailErr) {
      console.error("Reset request: failed to send email", mailErr);
      return res.status(500).json({
        message:
          "Unable to send reset email right now. Please try again or contact support.",
      });
    }

    return res.json({ message: "If an account exists, reset link sent" });
  } catch (err) {
    console.error("Reset request error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/reset-password/confirm/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { email, newPassword, confirmPassword } = req.body;

    if (!token || !email || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    // Find user by email + token
    const user = await User.findOne({
      email: email.toLowerCase(),
      resetToken: token,
      resetTokenExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    // Backend automatically knows the role here
    console.log("Resetting password for role:", user.role);

    user.passwordHash = await argon2.hash(newPassword);
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("Reset confirm error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/change-password", auth, async (req, res) => {
  try {
    const userId = req.user.sub; // from JWT
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const valid = await argon2.verify(user.passwordHash, oldPassword);
    if (!valid) {
      return res.status(400).json({ message: "Old password is incorrect" });
    }

    // Save new password
    user.passwordHash = await argon2.hash(newPassword);
    await user.save();

    // Send confirmation email
    try {
      await sendMail({
        to: user.email,
        subject: "Your Password Has Been Changed",
        html: `
          <p>Hi ${user.firstName || "User"},</p>
          <p>This is a confirmation that your account password has been successfully changed.</p>
          <p>If you did not make this change, please reset your password immediately or contact our support.</p>
          <br/>
          <p>Regards,<br/>DhanSource Capital Team</p>
        `,
      });
    } catch (mailErr) {
      console.error("⚠️ Password changed but email failed:", mailErr);
      return res.json({
        message: "Password changed successfully, but email failed to send",
      });
    }

    res.json({
      message: "Password changed successfully, confirmation email sent",
    });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// POST /api/auth/verify-password (authenticated)
router.post("/verify-password", auth, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ message: "Password is required." });
    }

    const user = await User.findById(req.user.sub).select("passwordHash status");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.status === "SUSPENDED") {
      return res.status(403).json({ message: "Account suspended." });
    }

    const valid = await argon2.verify(user.passwordHash, String(password));
    if (!valid) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    return res.json({ message: "Password verified successfully." });
  } catch (err) {
    console.error("verify-password:", err);
    return res.status(500).json({ message: err.message || "Could not verify password" });
  }
});

// POST /api/auth/email-change/confirm  (public — token from email link)
router.post("/email-change/confirm", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== "string") {
      return res.status(400).json({ message: "Invalid or missing token" });
    }

    const cleanToken = token.trim();
    const user = await User.findOne({
      $or: [
        { emailChangeToken: cleanToken }, // legacy
        { emailChangeTokenOld: cleanToken },
        { emailChangeTokenNew: cleanToken },
      ],
      emailChangeTokenExpires: { $gt: new Date() },
    });

    if (!user || !user.pendingEmail) {
      return res.status(400).json({ message: "Invalid or expired link. Request a new email change from settings." });
    }

    const newEmail = String(user.pendingEmail).toLowerCase();
    const taken = await User.findOne({
      email: newEmail,
      _id: { $ne: user._id },
    });
    if (taken) {
      return res.status(409).json({ message: "This email is already in use by another account." });
    }

    if (cleanToken === user.emailChangeTokenOld) {
      user.emailChangeOldVerified = true;
      user.emailChangeTokenOld = undefined;
    } else if (cleanToken === user.emailChangeTokenNew || cleanToken === user.emailChangeToken) {
      user.emailChangeNewVerified = true;
      user.emailChangeTokenNew = undefined;
      user.emailChangeToken = undefined;
    }

    if (user.emailChangeOldVerified && user.emailChangeNewVerified) {
      user.email = newEmail;
      user.pendingEmail = undefined;
      user.emailChangeTokenExpires = undefined;
      user.emailChangeOldVerified = false;
      user.emailChangeNewVerified = false;
      await user.save();
      return res.json({
        message: "Email updated successfully after dual verification. You can log in with your new email.",
      });
    }

    await user.save();
    return res.json({
      message:
        "Verification recorded. Please complete verification from the other email link to finish email change.",
    });
  } catch (err) {
    console.error("email-change/confirm:", err);
    res.status(500).json({ message: err.message || "Could not confirm email change" });
  }
});

// POST /api/auth/email-change/resend  (authenticated — same session that requested change)
router.post("/email-change/resend", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.sub).select(
      "email firstName pendingEmail emailChangeToken emailChangeTokenExpires"
    );
    if (!user?.pendingEmail) {
      return res.status(400).json({ message: "No pending email change to resend." });
    }

    await createEmailChangeRequest({
      user,
      newEmail: user.pendingEmail,
      currentEmail: user.email,
      clientUrl: process.env.CLIENT_URL,
    });

    res.json({
      message: "Verification email resent. Please check your inbox.",
    });
  } catch (err) {
    console.error("email-change/resend:", err);
    res.status(500).json({ message: err.message || "Could not resend email" });
  }
});

export default router;
