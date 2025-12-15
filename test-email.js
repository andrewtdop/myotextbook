import FormData from "form-data";
import Mailgun from "mailgun.js";
import dotenv from "dotenv";

// Load .env file
dotenv.config();

async function sendSimpleMessage() {
  const mailgun = new Mailgun(FormData);
  const mg = mailgun.client({
    username: "api",
    key: process.env.MAILGUN_API_KEY || "API_KEY",
  });
  try {
    const data = await mg.messages.create("mg.myotext.org", {
      from: "Mailgun Sandbox <postmaster@mg.myotext.org>",
      to: ["Andrew Varsanyi <avarsanyi2@huskers.unl.edu>"],
      subject: "Hello Andrew Varsanyi",
      text: "Congratulations Andrew Varsanyi, you just sent an email with Mailgun! You are truly awesome!",
    });

    console.log("Email sent successfully!");
    console.log(data);
  } catch (error) {
    console.log("Error sending email:");
    console.log(error);
  }
}

sendSimpleMessage();
