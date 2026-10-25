import LoanProduct from "../models/LoanProduct.js";

/**
 * Public: Get active published loan products for client apps (Partner, Customer, Web)
 * @route GET /api/loan-products
 */
export const getPublicLoanProducts = async (req, res) => {
  try {
    const { client } = req.query; // 'partner', 'customer', 'web'

    const filter = { status: "ACTIVE" };

    if (client === "partner") {
      filter.publishToPartnerApp = true;
    } else if (client === "customer") {
      filter.publishToCustomerApp = true;
    } else if (client === "web") {
      filter.publishToWeb = true;
    }

    const products = await LoanProduct.find(filter)
      .sort({ displayOrder: 1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: products.length,
      data: products,
    });
  } catch (error) {
    console.error("Error fetching public loan products:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch loan products",
      error: error.message,
    });
  }
};

/**
 * Public: Get single loan product schema by code (e.g. PERSONAL, BUSINESS, CAR_LOAN)
 * @route GET /api/loan-products/:code
 */
export const getLoanProductByCode = async (req, res) => {
  try {
    const { code } = req.params;
    const product = await LoanProduct.findOne({
      code: String(code).toUpperCase().trim(),
      status: "ACTIVE",
    }).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: `Loan product with code '${code}' not found or inactive.`,
      });
    }

    return res.status(200).json({
      success: true,
      data: product,
    });
  } catch (error) {
    console.error("Error fetching loan product by code:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch loan product details",
      error: error.message,
    });
  }
};

/**
 * Admin: Get all loan products (ACTIVE, DRAFT, ARCHIVED)
 * @route GET /api/admin/loan-products
 */
export const getAllLoanProductsAdmin = async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};

    if (status && status !== "ALL") {
      filter.status = status;
    }

    if (search && search.trim()) {
      filter.$or = [
        { name: { $regex: search.trim(), $options: "i" } },
        { code: { $regex: search.trim(), $options: "i" } },
      ];
    }

    const products = await LoanProduct.find(filter)
      .sort({ displayOrder: 1, updatedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: products.length,
      data: products,
    });
  } catch (error) {
    console.error("Error fetching admin loan products:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch loan products",
      error: error.message,
    });
  }
};

/**
 * Admin: Create a new dynamic loan product
 * @route POST /api/admin/loan-products
 */
export const createLoanProduct = async (req, res) => {
  try {
    const {
      name,
      code,
      slug,
      iconUrl,
      badgeText,
      description,
      minAmount,
      maxAmount,
      minTenureMonths,
      maxTenureMonths,
      interestRateDisplay,
      publishToWeb,
      publishToPartnerApp,
      publishToCustomerApp,
      status,
      steps,
      customFields,
      requiredDocuments,
      displayOrder,
    } = req.body;

    if (!name || !code) {
      return res.status(400).json({
        success: false,
        message: "Loan product name and unique code are required.",
      });
    }

    const normalizedCode = String(code).toUpperCase().trim();
    const normalizedSlug = slug
      ? String(slug).toLowerCase().trim()
      : normalizedCode.toLowerCase().replace(/_/g, "-");

    // Check duplicate code or slug
    const existing = await LoanProduct.findOne({
      $or: [{ code: normalizedCode }, { slug: normalizedSlug }],
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: `A loan product with code '${normalizedCode}' or slug '${normalizedSlug}' already exists.`,
      });
    }

    const newProduct = new LoanProduct({
      name: name.trim(),
      code: normalizedCode,
      slug: normalizedSlug,
      iconUrl: iconUrl || "",
      badgeText: badgeText || "Instant Approval",
      description: description || "",
      minAmount: minAmount !== undefined ? Number(minAmount) : 25000,
      maxAmount: maxAmount !== undefined ? Number(maxAmount) : 5000000,
      minTenureMonths: minTenureMonths !== undefined ? Number(minTenureMonths) : 6,
      maxTenureMonths: maxTenureMonths !== undefined ? Number(maxTenureMonths) : 60,
      interestRateDisplay: interestRateDisplay || "10.5% - 18%",
      publishToWeb: publishToWeb !== undefined ? Boolean(publishToWeb) : true,
      publishToPartnerApp: publishToPartnerApp !== undefined ? Boolean(publishToPartnerApp) : true,
      publishToCustomerApp: publishToCustomerApp !== undefined ? Boolean(publishToCustomerApp) : true,
      status: status || "ACTIVE",
      steps: Array.isArray(steps) && steps.length > 0 ? steps : undefined,
      customFields: Array.isArray(customFields) ? customFields : [],
      requiredDocuments: Array.isArray(requiredDocuments) ? requiredDocuments : [],
      displayOrder: displayOrder ? Number(displayOrder) : 0,
      createdBy: req.user?._id || req.user?.id,
    });

    await newProduct.save();

    return res.status(201).json({
      success: true,
      message: `Loan product '${newProduct.name}' created successfully.`,
      data: newProduct,
    });
  } catch (error) {
    console.error("Error creating loan product:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create loan product",
      error: error.message,
    });
  }
};

/**
 * Admin: Update an existing loan product
 * @route PUT /api/admin/loan-products/:id
 */
export const updateLoanProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await LoanProduct.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Loan product not found.",
      });
    }

    const updates = { ...req.body };
    delete updates._id;
    delete updates.createdAt;
    updates.updatedBy = req.user?._id || req.user?.id;

    if (updates.code) {
      updates.code = String(updates.code).toUpperCase().trim();
    }
    if (updates.slug) {
      updates.slug = String(updates.slug).toLowerCase().trim();
    }

    const updated = await LoanProduct.findByIdAndUpdate(id, { $set: updates }, { new: true });

    return res.status(200).json({
      success: true,
      message: `Loan product '${updated.name}' updated successfully.`,
      data: updated,
    });
  } catch (error) {
    console.error("Error updating loan product:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update loan product",
      error: error.message,
    });
  }
};

/**
 * Admin: Delete or archive a loan product
 * @route DELETE /api/admin/loan-products/:id
 */
export const deleteLoanProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { permanent } = req.query;

    if (permanent === "true") {
      await LoanProduct.findByIdAndDelete(id);
      return res.status(200).json({
        success: true,
        message: "Loan product permanently deleted.",
      });
    }

    // Soft delete by setting status ARCHIVED
    const archived = await LoanProduct.findByIdAndUpdate(
      id,
      { $set: { status: "ARCHIVED", updatedBy: req.user?._id || req.user?.id } },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: `Loan product '${archived?.name}' archived successfully.`,
      data: archived,
    });
  } catch (error) {
    console.error("Error archiving loan product:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to archive loan product",
      error: error.message,
    });
  }
};
