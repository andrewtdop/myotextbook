# MYOTextbook User Guide

A comprehensive guide to creating custom textbooks with MYOTextbook.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating Your First Project](#creating-your-first-project)
3. [Adding Content](#adding-content)
4. [Organizing Content](#organizing-content)
5. [Project Settings](#project-settings)
6. [Exporting Your Textbook](#exporting-your-textbook)
7. [Version Control](#version-control)
8. [Collaboration](#collaboration)
9. [User Account Management](#user-account-management)
10. [Tips and Best Practices](#tips-and-best-practices)

---

## Getting Started

### Logging In

1. Navigate to your MYOTextbook instance (e.g., `http://localhost:8080`)
2. Click the **Profile** button in the top-right corner

<img width="2072" height="818" alt="CleanShot 2025-12-15 at 16 59 01@2x" src="https://github.com/user-attachments/assets/49522173-9ccc-4587-9710-2f46e6280b67" />

4. Enter your username and password
5. Click **Login**

### Requesting Access (New Users)

If you don't have an account:

1. Click **Profile** button
2. Click **"Request Access"** at the bottom of the login modal
3. Fill out the form:
   - First Name
   - Last Name
   - Email
   - Affiliation (optional)
4. Click **Submit Request**
5. You'll receive an email with your credentials once approved by an administrator

**Note:** If you already have an account but forgot your password, submit a new request with the same email - the system will automatically send you your existing credentials.

### Dashboard Overview

After logging in, you'll see the **Projects Dashboard** with:

- **Search bar** - Filter projects by name or keywords
- **Projects table** - Shows all your projects and shared projects
- **New Project button** - Create a new textbook
- **Profile button** - Manage your account
- **Add User button** - (Admin only) Create new user accounts
- **Log Out button** - End your session

---

## Creating Your First Project

### Step 1: Create a New Project

<img width="3422" height="1466" alt="CleanShot 2025-12-15 at 16 59 34@2x" src="https://github.com/user-attachments/assets/24979195-147f-4cc3-abb5-93a06c7bcc80" />

1. Click the **"New Project"** button in the top-right corner
2. The editor view opens with an empty project
3. Enter a **project name** in the title field at the top
4. Add **keywords** (comma-separated) to help organize and search for your project
   - Example: `history, world war 2, economics`

### Step 2: Understanding the Editor Interface

The editor has several sections:

- **Back button** - Return to projects dashboard
- **Project name field** - Edit the title of your textbook
- **Project metadata** - Shows creation date, last modified, author
- **Keywords field** - Tags for categorizing and searching
- **Add Content panel** - Add new items to your textbook
- **Items Table** - Shows all content in your project
- **Options panel** - Project-wide settings
- **Export panel** - Generate PDF or EPUB files

---

## Adding Content

MYOTextbook supports multiple content types. Each type serves a different purpose in building your textbook.

### Content Types

#### 1. Title Page

Creates a formatted title page for your textbook.

**How to add:**
1. Select **"Title Page"** from the Type dropdown
2. Enter the **main title** in the Title field
3. (Optional) Enter a **subtitle**
4. Click **Add**

**Example:**
- Title: `Introduction to American History`
- Subtitle: `From Colonial Times to Modern Era`

<img width="2012" height="906" alt="CleanShot 2025-12-15 at 17 00 17@2x" src="https://github.com/user-attachments/assets/9d180571-3fa4-49bb-9f62-866d4248ca0f" />

---

#### 2. Heading

Creates section breaks and chapter headings in your textbook.

**How to add:**
1. Select **"Heading"** from the Type dropdown
2. Enter the **heading text** in the Title field
3. Click **Add**

**Example:**
- Title: `Chapter 1: The Revolutionary War`

**Best practice:** Use headings to organize content into logical sections (chapters, units, topics).

<img width="1970" height="1574" alt="CleanShot 2025-12-15 at 17 00 54@2x" src="https://github.com/user-attachments/assets/ae1929cd-bcbd-4c3e-bf7a-a91139972586" />

---

#### 3. URL (Website)

Extracts and includes content from any website.

**How to add:**
1. Select **"URL"** from the Type dropdown
2. Enter a **caption/title** for the content
3. Enter the **full URL** (must start with `https://` or `http://`)
4. (Optional) Check **"Cache website content"** to save a snapshot
5. Click **Add**

**Example:**
- Title: `The Declaration of Independence`
- URL: `https://www.archives.gov/founding-docs/declaration-transcript`

**Caching:** When checked, the system saves the current version of the webpage. This prevents content from changing if the website is updated later.

**Bot Protection:** Some websites block automated access (like Cloudflare). If this happens:
- The page will be skipped during export
- You'll see a notification listing failed pages
- Consider using a different source or manually saving the content

<img width="1940" height="654" alt="CleanShot 2025-12-15 at 17 01 42@2x" src="https://github.com/user-attachments/assets/b8b87f59-10dc-4463-a92c-6fa75beab836" />

---

#### 4. Wikipedia

Automatically fetches and formats Wikipedia articles.

**How to add:**
1. Select **"Wikipedia"** from the Type dropdown
2. Enter a **title** (this will be shown in your textbook)
3. Enter the **Wikipedia page name** in the URL field
   - Example: `World_War_II` (from `https://en.wikipedia.org/wiki/World_War_II`)
4. Click **Add**

**Example:**
- Title: `World War II Overview`
- URL: `World_War_II`

**Note:** The system automatically extracts the article content and formats it properly, removing navigation elements and sidebars.

<img width="1802" height="1520" alt="CleanShot 2025-12-15 at 17 03 07@2x" src="https://github.com/user-attachments/assets/077db296-90e9-47c1-a532-0b6e88799f3b" />

---

#### 5. Image

Includes images in your textbook with captions.

**How to add:**
1. Select **"Image"** from the Type dropdown
2. Enter a **caption** in the Title field
3. Click **Browse** and select an image file
4. Click **Add**

**Supported formats:** JPG, PNG, GIF, WebP

**Best practice:** Use descriptive captions that explain what the image shows and why it's relevant.

**Example:**
- Caption: `Figure 1.2: The signing of the Declaration of Independence, John Trumbull (1819)`

<img width="2008" height="1888" alt="CleanShot 2025-12-15 at 17 03 47@2x" src="https://github.com/user-attachments/assets/2a1be662-c164-4732-afe3-f75f836c8e0f" />

---

#### 6. File (PDF or Word Document)

Converts and includes PDF or Word documents.

**How to add:**
1. Select **"File"** from the Type dropdown
2. Enter a **title** for the document
3. Click **Browse** and select your file
4. Click **Add**

**Supported formats:**
- PDF (`.pdf`)
- Word Documents (`.docx`)

**Note:** The system converts documents to markdown format for consistent styling with the rest of your textbook.

**Example:**
- Title: `Lecture Notes: The Civil Rights Movement`
- File: `civil_rights_lecture.pdf`

<img width="1950" height="592" alt="CleanShot 2025-12-15 at 17 04 14@2x" src="https://github.com/user-attachments/assets/bcbc516e-5406-4d09-8f5e-7e6ffc4876e9" />

---

### Managing Cache for Websites

Website caching allows you to preserve the current state of web content.

**To cache a website:**
1. When adding a URL, check the **"Cache website content"** box, OR
2. For existing URL items, check the **Cached** checkbox in the items table

**To update cached content:**
- Uncheck the **Cached** box
- Check it again to fetch fresh content

**When to use caching:**
- News articles that may be removed or paywalled later
- Blog posts that might be deleted
- Any content that could change or disappear
- Resources you want to preserve in their current state

**Cache indicator:** Cached items show a checkmark in the "Cached" column of the items table.

<img width="2004" height="1604" alt="CleanShot 2025-12-15 at 17 04 36@2x" src="https://github.com/user-attachments/assets/19a8b05e-1afb-4c2b-909f-aef662b7bc89" />

---

## Organizing Content

### Reordering Items

Content appears in your textbook in the order shown in the items table.

**To reorder items:**
1. Look for the **⋮⋮** (drag handle) icon on the left of each item
2. Click and drag the item to a new position
3. Release to drop it in place
4. Changes are saved automatically

**Best practice:** Organize your content logically:
- Start with a title page
- Use headings to create chapters/sections
- Group related content together
- Place attribution information at the end

![CleanShot 2025-12-15 at 17 05 45](https://github.com/user-attachments/assets/16840629-441d-452b-8e81-a2acf981f026)

---

### Editing Items

**To edit an item:**
1. Click the item's text in the **Title/Caption** column
2. The text becomes editable
3. Make your changes
4. Click outside the field or press Enter to save

**To delete an item:**
1. Click the **red X button** on the right side of the item row
2. Confirm the deletion
3. The item is permanently removed

**Warning:** Deletions cannot be undone! Consider creating a copy of your project before making major changes.

<img width="2000" height="404" alt="CleanShot 2025-12-15 at 17 06 21@2x" src="https://github.com/user-attachments/assets/f840ac06-dd4a-49ae-b688-25d972c6cf0f" />

---

### Using Keywords

Keywords help you organize and search for projects.

**To add keywords:**
1. In the editor, find the **Keywords** field below the project name
2. Enter keywords separated by commas
3. Keywords are saved automatically

**Example keywords:**
- Subject areas: `history, science, literature`
- Grade levels: `high school, college, graduate`
- Topics: `american revolution, genetics, shakespeare`
- Purposes: `syllabus, research, teaching`

**Searching by keywords:**
- On the Projects Dashboard, type keywords in the search bar
- Projects matching your keywords will be filtered automatically

---

## Project Settings

### Options Panel

The Options panel (below the Add Content section) controls export settings.

**Available options:**

#### Author Name
- Your name as it appears in the textbook
- Example: `Dr. Jane Smith`

#### Attribution Page
- Automatically generates a page listing all sources
- Appears at the end of the textbook
- Includes links to original content

#### Attribution Text
- Custom text to include on the attribution page
- Use for copyright notices, license information, or acknowledgments
- Example: `This textbook is licensed under CC BY-NC 4.0`

#### Page Numbers
- Adds page numbers to PDF exports
- Position options: top-right, bottom-center, etc.

#### Table of Contents
- Automatically generates a clickable table of contents
- Based on your headings and content items
- Includes page numbers in PDF format

---

## Exporting Your Textbook

Once your content is organized, export your textbook as a PDF or EPUB file.

### PDF Export

Best for: Printing, sharing as a document, preserving exact layout

**To export as PDF:**
1. Scroll to the **Export** panel
2. Click the **"Export to PDF"** button
3. Wait for processing (a progress modal will appear)
4. The PDF will download automatically when complete

**PDF features:**
- Professional formatting
- Automatic page numbering
- Table of contents with page numbers
- Preserved images and formatting
- Attribution page at the end

<img width="2008" height="1924" alt="CleanShot 2025-12-15 at 17 07 09@2x" src="https://github.com/user-attachments/assets/856f5f1e-a6f8-4e7c-9233-8fa6b9fd8c1a" />

---

### EPUB Export

Best for: E-readers, tablets, responsive reading on different devices

**To export as EPUB:**
1. Scroll to the **Export** panel
2. Click the **"Export to EPUB"** button
3. Wait for processing
4. The EPUB file will download automatically

**EPUB features:**
- Reflowable text (adapts to screen size)
- Table of contents navigation
- Compatible with most e-readers (Kindle, Kobo, Apple Books)
- Embedded images

---

### Export Progress

During export, you'll see a progress modal showing:

1. **Building content** - Converting items to markdown
2. **Processing images** - Embedding and formatting images
3. **Generating document** - Creating the final file

**If pages fail to load:**
- You'll see a notification listing failed pages
- Common causes: Bot protection, broken links, network issues
- The export continues without the failed pages
- Review the list and consider alternative sources

<img width="1300" height="478" alt="CleanShot 2025-12-15 at 17 07 47@2x" src="https://github.com/user-attachments/assets/05ac0738-b24a-4861-bc4d-f5fc7aa06f9b" />

---

### Finding Your Exported Files

Exported files are downloaded to your browser's default download folder.

**File naming:**
- Format: `ProjectName-timestamp.pdf` or `ProjectName-timestamp.epub`
- Example: `American_History_101-1702684523456.pdf`

**Tip:** Rename the file to something more meaningful after downloading.

---

## Version Control

MYOTextbook includes basic version control to track changes and create copies.

### Creating a Copy

**To create a copy of a project:**
1. In the projects table, click the **"Copy"** button for any project
2. A copy is created with " (Copy)" appended to the name
3. The copy opens in the editor automatically
4. You can now edit the copy without affecting the original

**Use cases:**
- Creating different versions for different classes
- Testing major changes before applying to the main version
- Preserving a snapshot before extensive edits
- Creating derivative works from a base template

---

### Version Logs

The system automatically tracks version changes.

**What's tracked:**
- Project copies (who copied, when)
- Major edits (saved as new versions)
- Version numbers (v1, v2, v3, etc.)

**Viewing version info:**
- Version information appears in the project metadata
- Shows current version and original author

<img width="1950" height="1454" alt="CleanShot 2025-12-15 at 17 08 17@2x" src="https://github.com/user-attachments/assets/442c5bfb-5b32-4c34-8978-2bee0570cb75" />

---

## Collaboration

### Sharing Projects

Currently, all users can see all projects in the system.

**Implications:**
- Any logged-in user can view and copy your projects
- Users can create their own copies to edit independently
- Originals remain unaffected by copies

**Best practice:**
- Use descriptive names and keywords
- Mark in-progress projects clearly (e.g., "DRAFT: ...")
- Keep sensitive content in private instances

**Future features:**
- Private projects visible only to specific users
- Permission-based editing rights
- Real-time collaboration on the same project

---

## User Account Management

### Profile Page

Access your profile by clicking the **Profile** button (when logged in).

**You can update:**
- First Name
- Last Name
- Affiliation
- Email
- Password (optional - leave blank to keep current password)

**To save changes:**
1. Edit the fields
2. Click **Save**
3. Changes take effect immediately

<img width="1410" height="684" alt="CleanShot 2025-12-15 at 17 08 43@2x" src="https://github.com/user-attachments/assets/fa7a0758-e361-4f52-a74a-52c0f061b170" />

---

### Admin Functions

Users with admin privileges see additional features.

#### Adding Users

**Single user:**
1. Click **"Add User"** button in the header
2. Fill out the user form:
   - Username (usually email)
   - Password
   - First Name
   - Last Name
   - Affiliation
   - Email
   - Admin checkbox (optional)
3. Click **Create**

**Bulk upload:**
1. Click **"Add User"** → **"Bulk CSV Upload"** tab
2. Prepare a CSV file with columns:
   ```
   username,password,first_name,last_name,affiliation,email,is_admin
   ```
3. Click **Browse** and select your CSV file
4. Click **Upload**
5. Review the success message

<img width="900" height="132" alt="CleanShot 2025-12-15 at 17 09 32@2x" src="https://github.com/user-attachments/assets/8c254ec3-a3ec-4fed-a5cb-83a984a2a94e" />

---

#### Managing Access Requests

When users request access, admins see pending requests in their Profile page.

**To review requests:**
1. Click **Profile**
2. Scroll to **"Pending Access Requests"** section (admin only)
3. Each request shows:
   - User's name
   - Email
   - Affiliation
   - Request date

**To approve:**
1. Click the **green "Approve"** button
2. Confirm the action
3. System automatically:
   - Generates a random password
   - Creates the user account
   - Sends credentials via email

**To decline:**
1. Click the **"Decline"** button
2. Confirm the action
3. User receives a polite email explaining they can provide more information

---

## Tips and Best Practices

### Content Organization

1. **Start with structure**
   - Add your title page first
   - Create heading placeholders for chapters
   - Fill in content within each section

2. **Use consistent naming**
   - Keep titles descriptive and clear
   - Use parallel structure for similar items
   - Example: "Chapter 1: ...", "Chapter 2: ...", etc.

3. **Group related content**
   - Keep all materials for one topic together
   - Use headings to separate major sections
   - Order content logically (chronologically, by difficulty, etc.)

---

### Working with Web Content

1. **Cache important content**
   - Always cache content that might disappear
   - Cache paywalled articles while accessible
   - Update cache if source content changes significantly

2. **Handle bot protection**
   - Some sites block automated access (especially Cloudflare)
   - Alternative: Manually save the page and upload as a file
   - Or: Find the same content on a different site

3. **Verify extracted content**
   - After adding a URL, export a test PDF to verify formatting
   - Some sites have complex layouts that may not extract cleanly
   - Edit titles/captions to provide context

---

### Exporting

1. **Test export early**
   - Don't wait until your project is complete
   - Test with a few items to verify formatting
   - Adjust content as needed

2. **Review failed pages**
   - If pages fail during export, note them
   - Find alternative sources or upload manually
   - Re-export after fixing issues

3. **Large projects**
   - Projects with many items take longer to export
   - Be patient during processing
   - Consider breaking very large textbooks into volumes

---

### Project Management

1. **Use descriptive names**
   - Include subject, level, and semester in project names
   - Example: "BIO101 Spring 2024 - Cell Biology"

2. **Add comprehensive keywords**
   - More keywords = easier to find later
   - Include subject, grade level, topic, semester

3. **Create versions intentionally**
   - Copy before making major changes
   - Name versions clearly: "v1 - Original", "v2 - Fall Updates"

4. **Clean up old projects**
   - Delete drafts and test projects periodically
   - Keep your dashboard organized

---

### Accessibility

1. **Use descriptive titles**
   - Screen readers rely on clear, descriptive text
   - Avoid generic titles like "Article 1"

2. **Add image captions**
   - Always include meaningful captions for images
   - Describe what's shown and why it matters

3. **Structure with headings**
   - Use headings to create logical document structure
   - This helps all readers navigate content

---

## Troubleshooting

### Common Issues

**Problem:** Can't log in
- **Solution:** Verify username/password are correct
- **Solution:** Check that your account has been approved
- **Solution:** Request access again to receive credentials via email

**Problem:** URL content not loading
- **Solution:** Verify the URL is correct and accessible
- **Solution:** Try caching the content
- **Solution:** The site may block automated access - use an alternative source

**Problem:** Export fails
- **Solution:** Check that all URLs are valid
- **Solution:** Review console for error messages
- **Solution:** Try exporting without problematic items, then add them back one by one

**Problem:** Images not appearing in export
- **Solution:** Verify image files are under 5MB
- **Solution:** Ensure images are in supported formats (JPG, PNG, GIF)
- **Solution:** Re-upload the image and try again

**Problem:** PDF looks wrong
- **Solution:** Check content order in items table
- **Solution:** Verify headings are used appropriately
- **Solution:** Review options panel settings (page numbers, TOC)

---

## Getting Help

For additional support:

1. **Check this guide** for detailed instructions
2. **Review the README** for technical setup information
3. **Contact your administrator** for account or access issues
4. **Report bugs** to the development team with:
   - What you were trying to do
   - What happened instead
   - Screenshots if relevant

---

## Appendix: Keyboard Shortcuts

*(To be implemented in future versions)*

- `Ctrl/Cmd + S` - Save project
- `Ctrl/Cmd + N` - New project
- `Ctrl/Cmd + E` - Export to PDF
- `Escape` - Close modal

---

## Appendix: Example Project Structure

Here's an example of a well-organized textbook project:

```
📄 Title Page: "Introduction to Economics"
   Subtitle: "Principles and Applications"

📑 Heading: "Part I: Fundamentals"

📑 Heading: "Chapter 1: What is Economics?"
📄 Wikipedia: "Economics"
🔗 URL: "Basic Economic Concepts" (cached)
🖼️ Image: "Figure 1.1: Supply and Demand Curve"

📑 Heading: "Chapter 2: Market Forces"
📄 File: "lecture_notes_chapter2.pdf"
🔗 URL: "Market Equilibrium Examples"

📑 Heading: "Part II: Applications"

📑 Heading: "Chapter 3: Labor Markets"
🔗 URL: "BLS Employment Statistics" (cached)
🖼️ Image: "Figure 3.1: Unemployment Rates Over Time"

📑 Heading: "Chapter 4: International Trade"
📄 Wikipedia: "International_trade"
📄 File: "trade_agreement_analysis.docx"

📄 Attribution Page (automatically added)
```

This structure provides:
- Clear hierarchy with parts and chapters
- Mix of content types for variety
- Logical progression of topics
- Proper use of headings for navigation

---

*Last updated: December 2025*
