import axios from "axios";

/**
 * Fibe (EarlySalary) Digital Lending API Service
 * Handles Instant Pre-Qualification (Soft Pull), Lead Creation, Status Tracking & Webhooks.
 */

const FIBE_BASE_URL =
  process.env.FIBE_API_URL || "https://sandbox.fibe.in/api/v2";
const FIBE_CLIENT_ID = process.env.FIBE_CLIENT_ID || "";
const FIBE_CLIENT_SECRET = process.env.FIBE_CLIENT_SECRET || "";
const FIBE_SOURCE_CODE = process.env.FIBE_SOURCE_CODE || "DHANSOURCE";

/**
 * Generate Authorization Token / Headers for Fibe API
 */
function getFibeHeaders() {
  return {
    "Content-Type": "application/json",
    "x-client-id": FIBE_CLIENT_ID,
    "x-client-secret": FIBE_CLIENT_SECRET,
    "x-source-code": FIBE_SOURCE_CODE,
  };
}

export const fibeService = {
  /**
   * 1. Instant Eligibility & Pre-Qualification Check (Soft Pull - 30s TAT)
   * @param {Object} params
   * @param {string} params.pan - Customer PAN (e.g. ABCDE1234F)
   * @param {string} params.mobile - 10-digit mobile number
   * @param {string} params.dob - Date of Birth (YYYY-MM-DD)
   * @param {number} params.salary - Monthly Net Salary
   * @param {string} params.pincode - 6-digit residential pincode
   */
  checkInstantEligibility: async ({ pan, mobile, dob, salary, pincode }) => {
    try {
      // If live API keys are not configured yet, return structured pre-evaluation response
      if (!FIBE_CLIENT_ID) {
        const isEligible = Number(salary) >= 15000;
        const maxLimit = isEligible
          ? Math.min(500000, Math.round(Number(salary) * 3.5))
          : 0;

        return {
          success: true,
          isMock: true,
          lenderName: "Fibe (EarlySalary)",
          eligible: isEligible,
          maxSanctionAmount: maxLimit,
          startingRoi: "12.00% p.a.",
          minTenureMonths: 3,
          maxTenureMonths: 36,
          disbursalSpeed: "10 Minutes",
          message: isEligible
            ? "Pre-approved based on income criteria"
            : "Minimum required salary is ₹15,000/month",
        };
      }

      const response = await axios.post(
        `${FIBE_BASE_URL}/leads/check-eligibility`,
        {
          panNumber: pan.toUpperCase(),
          mobileNumber: mobile,
          dateOfBirth: dob,
          monthlySalary: Number(salary),
          residencePincode: pincode,
          sourceCode: FIBE_SOURCE_CODE,
        },
        { headers: getFibeHeaders(), timeout: 15000 }
      );

      return {
        success: true,
        lenderName: "Fibe",
        eligible: response.data?.eligible || false,
        maxSanctionAmount: response.data?.sanctionLimit || 0,
        roi: response.data?.interestRate || "12.00%",
        offerId: response.data?.offerId || null,
        redirectUrl: response.data?.journeyUrl || null,
      };
    } catch (err) {
      console.error("Fibe Eligibility Error:", err.response?.data || err.message);
      return {
        success: false,
        lenderName: "Fibe",
        eligible: false,
        error: err.response?.data?.message || err.message,
      };
    }
  },

  /**
   * 2. Submit Complete Lead & Initialize Digital eKYC / Disbursal Journey
   */
  createLead: async ({ customer, product, requestedAmount }) => {
    try {
      if (!FIBE_CLIENT_ID) {
        return {
          success: true,
          isMock: true,
          fibeLeadId: `FIBE_${Date.now()}`,
          status: "PRE_APPROVED",
          journeyUrl: "https://dhansourcecapital.com/digital-journey",
        };
      }

      const response = await axios.post(
        `${FIBE_BASE_URL}/leads/create`,
        {
          personalDetails: {
            firstName: customer.firstName,
            lastName: customer.lastName || "",
            email: customer.email,
            mobile: customer.phone,
            pan: customer.panNumber,
            dob: customer.dateOfBirth,
            gender: customer.gender,
          },
          employmentDetails: {
            companyName: product.companyName,
            monthlyIncome: Number(product.monthlySalary),
            designation: product.designation,
          },
          addressDetails: {
            currentAddress: product.currentAddress,
            pincode: product.currentAddressPinCode,
          },
          loanDetails: {
            requestedAmount: Number(requestedAmount),
          },
          sourceCode: FIBE_SOURCE_CODE,
        },
        { headers: getFibeHeaders() }
      );

      return response.data;
    } catch (err) {
      console.error("Fibe Lead Creation Error:", err.response?.data || err.message);
      throw new Error(err.response?.data?.message || "Failed to create lead with Fibe");
    }
  },

  /**
   * 3. Fetch Real-time Lead Disbursal Status
   */
  getLeadStatus: async (fibeLeadId) => {
    try {
      if (!FIBE_CLIENT_ID) {
        return { status: "SANCTIONED", disbursedAmount: 200000 };
      }

      const response = await axios.get(
        `${FIBE_BASE_URL}/leads/${fibeLeadId}/status`,
        { headers: getFibeHeaders() }
      );
      return response.data;
    } catch (err) {
      console.error("Fibe Status Check Error:", err.response?.data || err.message);
      throw err;
    }
  },
};

export default fibeService;
