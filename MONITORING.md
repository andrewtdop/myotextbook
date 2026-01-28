# System Monitoring & Alerts

## Overview

The MYOTextbook server now includes comprehensive monitoring that sends email alerts via Mailgun when issues are detected.

## Configuration

Add to your `.env` file:

```env
MAILGUN_API_KEY=your-mailgun-api-key
MAILGUN_DOMAIN=mg.myotext.org
ADMIN_EMAIL=avarsanyi2@nebraska.edu
```

## Alert Types

### Critical Alerts
- **Server Crashes** - Uncaught exceptions that cause the server to exit
- **Unhandled Promise Rejections** - Async errors that weren't caught

### Error Alerts
- **Route Handler Errors** - 500 errors in API endpoints

### Warning Alerts
- **High Memory Usage** - System memory usage >90%
- **Low Disk Space** - Disk usage >90% on data directory
- **Excessive Temp Directories** - More than 50 build/cache directories (cleanup may be failing)

### Info Alerts
- **Server Started** - Sent when server successfully starts up

## Alert Rate Limiting

To prevent spam, the same alert type will only be sent once per hour. Subsequent occurrences within that hour are logged but not emailed.

## Monitoring Schedule

- **Health checks** run every 15 minutes
- **Initial check** runs 30 seconds after startup
- **Temp directory cleanup** runs on startup (removes directories >24 hours old)

## What Gets Monitored

### Memory
- Heap usage (JavaScript memory)
- RSS (Resident Set Size - total process memory)
- System memory percentage

### Disk
- Disk usage percentage on data directory
- Number of temp directories

### Errors
- All uncaught exceptions
- All unhandled promise rejections  
- All 500-level errors in route handlers

## Fixes Implemented

### Kernel Lockup Prevention
- **SQLite journal mode changed from WAL to DELETE** - Reduces I/O pressure on virtual disks
- **Automatic temp directory cleanup** - Prevents accumulation of build artifacts
- **Cleanup on export completion** - Removes temporary files immediately after use

### Benefits
- Prevents I/O storms that caused kernel soft lockups
- Reduces disk space usage
- Improves overall system stability in VM environments

## Testing Monitoring

To test that alerts are working:

```bash
# Test uncaught exception (will crash server)
curl -X POST http://localhost:8080/api/test-crash

# Check server logs
tail -f /path/to/server/logs
```

## Viewing Alerts

Check your email at `avarsanyi2@nebraska.edu` for alerts with subject lines like:
- `[MYOText CRITICAL] Server Crashed`
- `[MYOText WARNING] High Memory Usage`
- `[MYOText ERROR] Server Error in Route Handler`
- `[MYOText INFO] Server Started`

## Troubleshooting

**Not receiving alerts?**
1. Check Mailgun credentials in `.env`
2. Verify `ADMIN_EMAIL` is set correctly
3. Check server logs for "Mailgun configured" message on startup
4. Check spam folder

**Too many alerts?**
- Alerts are rate-limited to once per hour per type
- If you're getting too many different alerts, investigate the underlying issues

**Server still having issues?**
Check these indicators in alerts:
- Memory usage consistently high → Increase VM RAM
- Disk space low → Clean up old exports or increase disk size
- Many temp directories → Cleanup may not be working, check file permissions
