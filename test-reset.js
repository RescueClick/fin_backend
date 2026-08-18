import axios from "axios";

async function test() {
  try {
    const email = "sanjaygawai6344@gmail.com";
    
    // Step 1: Request forgot password
    console.log("Requesting forgot password...");
    let res = await axios.post("http://localhost:5000/api/auth/forgot-password", { email });
    console.log("Forgot password response:", res.data);
    
    // Fetch user from DB to get the OTP
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect("mongodb+srv://bagadanil09_db_user:862405@cluster0.t9huxno.mongodb.net/trustlinedb?retryWrites=true&w=majority");
    const { User } = await import("./src/models/User.js");
    const user = await User.findOne({ email });
    const otp = user.otpCode;
    console.log("Fetched OTP from DB:", otp);
    
    // Step 2: Verify OTP
    console.log("Verifying OTP...");
    res = await axios.post("http://localhost:5000/api/auth/verify-otp", { email, otp });
    console.log("Verify OTP response:", res.data);
    
    // Step 3: Reset password
    console.log("Resetting password...");
    res = await axios.post("http://localhost:5000/api/auth/reset-password", {
      email,
      otp,
      newPassword: "NewPassword123!"
    });
    console.log("Reset password response:", res.data);
    
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
