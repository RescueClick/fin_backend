export const FILE_REVIEW_MAX = 500;
export const FILE_REVIEW_HISTORY_LIMIT = 20;

export function publicFileReview(review) {
  const text = String(review?.text || "").trim();
  if (!text) return null;
  return {
    text,
    updatedByName: review.updatedByName || "",
    updatedByRole: review.updatedByRole || "",
    updatedAt: review.updatedAt || null,
  };
}

function staffName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || "Staff";
}

/**
 * Replace the current loan-file review and keep the previous note in history.
 * `app` must be a mongoose document.
 */
export async function saveFileReview(app, user, rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    const err = new Error("Review text is required.");
    err.status = 400;
    throw err;
  }
  if (text.length > FILE_REVIEW_MAX) {
    const err = new Error(`Review must be ${FILE_REVIEW_MAX} characters or fewer.`);
    err.status = 400;
    throw err;
  }

  const previous = publicFileReview(app.fileReview);
  if (previous) {
    const history = Array.isArray(app.fileReviewHistory) ? [...app.fileReviewHistory] : [];
    history.push({
      text: previous.text,
      updatedBy: app.fileReview?.updatedBy || null,
      updatedByName: previous.updatedByName,
      updatedByRole: previous.updatedByRole,
      updatedAt: previous.updatedAt || new Date(),
    });
    app.fileReviewHistory = history.slice(-FILE_REVIEW_HISTORY_LIMIT);
  }

  app.fileReview = {
    text,
    updatedBy: user?._id || null,
    updatedByName: staffName(user),
    updatedByRole: user?.role || "",
    updatedAt: new Date(),
  };

  await app.save();
  return { fileReview: publicFileReview(app.fileReview) };
}
