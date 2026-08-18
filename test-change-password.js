import axios from "axios";

async function test() {
  try {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect("mongodb+srv://bagadanil09_db_user:862405@cluster0.t9huxno.mongodb.net/trustlinedb?retryWrites=true&w=majority");
    const { User } = await import("./src/models/User.js");
    const { signAccessToken } = await import("./src/utils/jwt.js");

    const user = await User.findOne({ email: "sanjaygawai6344@gmail.com" });
    if (!user) {
        console.error("User not found");
        return process.exit(1);
    }
    const token = signAccessToken({
      sub: String(user._id),
      role: user.role,
    });
    
    // We don't know the actual old password, so it will return 400 Old password is incorrect.
    // If it returns 400, then NO 500 error happens!
    console.log("Testing change-password...");
    const res = await axios.post("http://localhost:5000/api/auth/change-password", {
      oldPassword: "wrongpassword",
      newPassword: "NewPassword123!",
      confirmPassword: "NewPassword123!"
    }, {
        headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log("Change password response:", res.data);
    await mongoose.disconnect();
  } catch (err) {
    if (err.response) {
      console.error("API Error:", err.response.status, err.response.data);
    } else {
      console.error("Error:", err.message);
    }
    process.exit(1);
  }
}

test();
