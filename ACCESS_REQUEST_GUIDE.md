# User Access Request System

This document describes the user access request workflow for MYOText.

## Overview

The access request system allows unauthenticated users to request accounts, admins to approve or decline requests, and automated email notifications via Mailgun.

## Features

1. **Request Access Form** - Unauthenticated users can submit access requests
2. **Admin Review Interface** - Admins see pending requests in their profile page
3. **Email Notifications** - Automated emails for:
   - New request notification to admin
   - Approval email with login credentials to user
   - Decline email with instructions to user
4. **Automatic Password Generation** - 12-character random passwords for approved users

## User Workflow

### 1. Request Access (Unauthenticated User)

- Click the **Profile** button in the header
- In the login modal, click **"Request Access"**
- Fill out the form:
  - First Name (required)
  - Last Name (required)
  - Email (required)
  - Affiliation (optional)
- Submit the request
- Receive confirmation message

### 2. Admin Notification

When a user submits an access request:
- Admin receives email notification at `admin@myotext.org`
- Email contains user's name, email, and affiliation
- Admin logs in to review the request

### 3. Admin Review

In the admin's profile page:
- **Pending Access Requests** section appears (admin only)
- Each request shows:
  - User's name
  - Email address
  - Affiliation (if provided)
  - Request date
- Admin can:
  - **Approve** - Creates account and sends credentials
  - **Decline** - Notifies user and allows them to reply

### 4. Approval

When admin approves:
- System generates random 12-character password
- Creates user account with email as username
- User receives email with:
  - Login credentials (username = email)
  - Generated password
  - Instructions to change password after first login

### 5. Decline

When admin declines:
- User receives polite email notification
- Email invites user to reply with additional information
- Request remains in system as declined

## Database Schema

### access_requests Table

```sql
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  affiliation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT
);
```

**Status values:**
- `pending` - Awaiting admin review
- `approved` - Request approved, user account created
- `declined` - Request declined by admin

## API Endpoints

### POST /api/access-request
Submit a new access request (no authentication required)

**Request Body:**
```json
{
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "affiliation": "University of Example"
}
```

**Response:**
```json
{
  "success": true,
  "id": "xyz123"
}
```

### GET /api/access-requests
Get all pending access requests (admin only)

**Response:**
```json
[
  {
    "id": "xyz123",
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "affiliation": "University of Example",
    "status": "pending",
    "created_at": "2024-01-15T10:30:00.000Z"
  }
]
```

### POST /api/access-requests/:id/approve
Approve an access request (admin only)

**Response:**
```json
{
  "success": true
}
```

### POST /api/access-requests/:id/decline
Decline an access request (admin only)

**Response:**
```json
{
  "success": true
}
```

## Email Configuration

### Mailgun Setup

1. Create a Mailgun account at https://www.mailgun.com/
2. Add and verify your domain
3. Get your API key from the Mailgun dashboard
4. Create a `.env` file in the project root:

```env
MAILGUN_API_KEY=your-api-key-here
MAILGUN_DOMAIN=your-domain.com
SESSION_SECRET=random-secret-string
```

### Email Templates

#### New Request Notification (to Admin)
```
Subject: New MYOText Access Request

Name: John Doe
Email: john@example.com
Affiliation: University of Example

Please log in to the system to approve or decline this request.
```

#### Approval Email (to User)
```
Subject: MYOText Access Approved

Hello John,

Your access request to MYOText has been approved!

You can now log in with the following credentials:

Username: john@example.com
Password: [generated-password]

Please change your password after your first login.

Best regards,
MYOText Team
```

#### Decline Email (to User)
```
Subject: MYOText Access Request Update

Hello John,

Thank you for your interest in MYOText.

We are unable to approve your access request at this time. If you would 
like to provide additional information about your planned usage of the 
tool, please reply to this email.

Best regards,
MYOText Team
```

## Security Features

1. **Email Validation** - Checks if email already exists before creating request
2. **Duplicate Prevention** - Only one pending request per email allowed
3. **Admin Authentication** - Approval/decline endpoints require admin privileges
4. **Secure Password Generation** - Uses cryptographically strong random passwords
5. **Password Characters** - Excludes ambiguous characters (0, O, 1, l, I)

## Testing Without Mailgun

If Mailgun is not configured:
- System will log email content to console
- All other functionality works normally
- Useful for development and testing

## UI Components

### Login Modal Enhancement
- Added "Request Access" link below login form
- Clicking opens Request Access modal

### Request Access Modal
- Clean form with required field indicators
- Informational text about approval process
- Form validation before submission

### Profile Modal Enhancement (Admin)
- New "Pending Access Requests" section
- Only visible to admin users
- Real-time list of pending requests
- Approve/Decline buttons for each request
- Shows "No pending requests" when empty

## Password Generation

Generated passwords:
- 12 characters long
- Mix of uppercase, lowercase, and numbers
- Excludes ambiguous characters (0, O, 1, l, I)
- Example: `RzN8kPmX4bQv`

Users should change this password after first login using the profile page.

## Error Handling

The system handles various error scenarios:

- **Duplicate Email** - "An account with this email already exists"
- **Pending Request** - "You already have a pending access request"
- **Missing Required Fields** - "First name, last name, and email are required"
- **Request Not Found** - "Request not found"
- **Already Processed** - "Request already processed"
- **Email Failure** - Logs error but continues processing

## Future Enhancements

Potential improvements:
- Email templates with customizable branding
- Request expiration after 30 days
- Admin notification preferences
- Batch approval/decline
- Request notes or comments
- Audit log of all access decisions
