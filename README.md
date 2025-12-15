# MYOTextbook

**Make Your Own Textbook** - A web-based platform for creating, managing, and exporting custom textbooks from various content sources.

## Overview

MYOTextbook allows educators and researchers to compile content from multiple sources (websites, PDFs, Word documents, Wikipedia articles, images) into professionally formatted textbooks. Export your projects as PDF or EPUB files with automatic page numbering, table of contents, and proper attribution.

## Features

- **Multi-Source Content**: Combine URLs, Wikipedia articles, uploaded files, and images
- **Website Caching**: Save snapshots of web content to preserve current versions
- **Drag-and-Drop Ordering**: Easily rearrange content items
- **Export Formats**: Generate PDF or EPUB files with professional formatting
- **Version Control**: Track changes and create copies of projects
- **Collaboration**: Share projects with other users
- **User Management**: Admin controls for user access and permissions
- **Access Request System**: Automated workflow for new user registration

## Prerequisites

- **Node.js** v18 or higher
- **Pandoc** (for document conversion)
- **pdfinfo** and **qpdf** (for PDF processing, usually comes with poppler-utils)
- **Mailgun Account** (optional, for email notifications)

### Installing System Dependencies

**macOS:**
```bash
brew install pandoc poppler
```

**Ubuntu/Debian:**
```bash
sudo apt-get install pandoc poppler-utils qpdf
```

**Windows:**
- Download Pandoc from https://pandoc.org/installing.html
- Download poppler from https://github.com/oschwartz10612/poppler-windows/releases/

## Installation

1. **Clone the repository:**
```bash
git clone https://github.com/yourusername/myotextbook.git
cd myotextbook
```

2. **Install Node.js dependencies:**
```bash
npm install
```

3. **Create environment configuration:**
```bash
cp .env.example .env
```

4. **Edit `.env` file with your configuration:**
```env
# Required: Session secret for secure sessions
SESSION_SECRET=your-random-secret-string-here

# Optional: Mailgun configuration for email notifications
MAILGUN_API_KEY=your-mailgun-api-key
MAILGUN_DOMAIN=mg.yourdomain.com

# Optional: Custom data directory (defaults to ./data)
# MYOT_DATA_DIR=/path/to/data/directory
```

5. **Start the server:**
```bash
node server.js
```

The application will be available at `http://localhost:8080`

## Initial Setup

### Creating the First Admin User

On first run, the database will be created automatically. You need to create an admin user:

1. Stop the server (Ctrl+C)
2. Run the following command to create an admin user:

```bash
node -e "
import Database from 'better-sqlite3';
const db = new Database('./data/db.sqlite');
const now = new Date().toISOString();
db.prepare(\`
  INSERT INTO users (username, password, first_name, last_name, email, is_admin, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 1, ?, ?)
\`).run('admin@yourdomain.com', 'changeme', 'Admin', 'User', 'admin@yourdomain.com', now, now);
console.log('Admin user created!');
db.close();
"
```

3. Restart the server
4. Log in with:
   - Username: `admin@yourdomain.com`
   - Password: `changeme`
5. **Important:** Change the password immediately after first login via Profile page

## Configuration

### Email Notifications (Optional)

To enable email notifications for the access request system:

1. Sign up for a Mailgun account at https://www.mailgun.com/
2. Verify your domain or use the Mailgun sandbox domain
3. Get your API key from the Mailgun dashboard
4. Add credentials to `.env`:
```env
MAILGUN_API_KEY=your-api-key-here
MAILGUN_DOMAIN=mg.yourdomain.com
```

5. Update the admin email in `server.js`:
```javascript
const ADMIN_EMAIL = 'your-email@yourdomain.com';
```

Without Mailgun configuration, the system will log email content to the console instead.

### Data Directory

By default, data is stored in `./data/`. To use a different location (e.g., to avoid cloud sync):

```env
MYOT_DATA_DIR=/path/to/custom/data/directory
```

The data directory contains:
- `db.sqlite` - SQLite database
- `uploads/` - User-uploaded files
- `exports/` - Generated PDF/EPUB files
- `tmp/` - Temporary build files

## Project Structure

```
myotextbook/
├── server.js              # Main server file
├── package.json           # Node.js dependencies
├── .env                   # Environment configuration (create from .env.example)
├── public/                # Frontend files
│   ├── index.html         # Main HTML
│   ├── app.js            # Frontend JavaScript
│   └── progress.js       # Export progress modal
├── data/                  # Data directory (created automatically)
│   ├── db.sqlite         # SQLite database
│   ├── uploads/          # Uploaded files
│   ├── exports/          # Generated exports
│   └── tmp/              # Temporary files
└── ACCESS_REQUEST_GUIDE.md # Access request system documentation
```

## Database Schema

The SQLite database includes the following tables:

- **users** - User accounts and authentication
- **projects** - Textbook projects
- **items** - Content items within projects
- **version_log** - Project version history
- **comments** - Project comments and notes
- **access_requests** - Pending user access requests

## User Management

### Adding Users

**As an Admin:**
1. Click "Add User" button in the header
2. Fill out user information
3. Create single users or bulk upload via CSV

**CSV Format for Bulk Upload:**
```csv
username,password,first_name,last_name,affiliation,email,is_admin
user1@example.com,password1,John,Doe,University A,user1@example.com,0
user2@example.com,password2,Jane,Smith,University B,user2@example.com,0
```

### Access Request System

Users can request access without admin intervention:
1. User clicks "Profile" → "Request Access"
2. Admin receives email notification
3. Admin approves/declines in Profile page
4. User receives email with credentials (if approved)

See `ACCESS_REQUEST_GUIDE.md` for detailed workflow.

## Deployment

### Production Considerations

1. **Use a process manager** (PM2, systemd, etc.):
```bash
npm install -g pm2
pm2 start server.js --name myotextbook
pm2 save
pm2 startup
```

2. **Set up reverse proxy** (nginx, Apache):
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

3. **Enable HTTPS** with Let's Encrypt:
```bash
sudo certbot --nginx -d yourdomain.com
```

4. **Configure firewall**:
```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

5. **Set production environment variables**:
```env
SESSION_SECRET=generate-a-long-random-secret
NODE_ENV=production
```

6. **Regular backups** of `data/db.sqlite` and `data/uploads/`

## Troubleshooting

### Pandoc not found
```
Error: Pandoc command failed
```
**Solution:** Install pandoc with your package manager (brew, apt-get, etc.)

### PDF page counting fails
```
Warning: Could not determine page count
```
**Solution:** Install poppler-utils (includes pdfinfo)

### Email not sending
**Solution:** Check Mailgun configuration in `.env` and verify API key is valid

### Database locked errors
**Solution:** Ensure only one server instance is running. Check for crashed processes:
```bash
pkill -f "node.*server.js"
```

### iCloud sync issues
**Solution:** Set `MYOT_DATA_DIR` to a non-iCloud location:
```env
MYOT_DATA_DIR=/usr/local/var/myotextbook
```

## Development

### Running in Development Mode

```bash
# Install dependencies
npm install

# Run server (auto-restarts not included)
node server.js

# For auto-restart on changes, use nodemon:
npm install -g nodemon
nodemon server.js
```

### API Endpoints

Key endpoints for integration:

- `POST /api/auth/login` - User authentication
- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id` - Get project details
- `POST /api/projects/:id/export` - Export project
- `POST /api/access-request` - Submit access request

See source code for complete API documentation.

## License

[Add your license here]

## Support

For issues, questions, or contributions:
- GitHub Issues: [your-repo-url]/issues
- Email: [your-support-email]

## Credits

Built with:
- Express.js - Web framework
- better-sqlite3 - Database
- Pandoc - Document conversion
- JSDOM & Readability - Content extraction
- Tailwind CSS - Frontend styling
- SortableJS - Drag-and-drop interface
- Mailgun - Email notifications
