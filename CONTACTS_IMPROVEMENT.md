# MasterClaw Improvement: Contacts Management CLI

## Summary

Added **`mc contacts`** command to manage personal and professional contacts in rex-deus. This fills a gap where the contacts.md file existed but was mostly empty placeholders with no tooling support.

## What Was Improved

### 1. New `mc contacts` Command Module (`lib/contacts.js`)

A comprehensive contacts management system with the following subcommands:

| Command | Description |
|---------|-------------|
| `mc contacts list` | List all contacts with filtering by category, tag, or search |
| `mc contacts show <name>` | Display detailed contact information |
| `mc contacts add` | Interactive contact creation |
| `mc contacts remove <name>` | Remove a contact with confirmation |
| `mc contacts export` | Export to JSON, CSV, or vCard formats |
| `mc contacts stats` | Show contact statistics by category |
| `mc contacts notify-info <name>` | Get notification contact info (for `mc notify` integration) |

### 2. Contact Categories

Contacts are organized into 5 categories with emoji icons:
- 👤 **Personal** — Friends, family
- 💼 **Professional** — Colleagues, business contacts  
- 🔧 **Technical** — Technical support, developers
- 🏢 **Services** — Hosting, domains, vendors
- 🚨 **Emergency** — Critical contacts

### 3. Security Features

- **Masked display by default** — Phone numbers show only last 4 digits, emails are masked
- **Secure file permissions** — Contacts files saved with 0o600 permissions
- **Audit logging** — All modifications logged via `logAudit()`
- **Private storage** — Data stored in rex-deus (private repository)

### 4. Dual Storage Format

Contacts are stored in both formats for flexibility:
- **JSON** (`contacts.json`) — Structured data for programmatic access
- **Markdown** (`contacts.md`) — Human-readable with formatted tables

### 5. Export Formats

Supports 3 export formats:
- **JSON** — Complete data with metadata
- **CSV** — Spreadsheet-compatible
- **vCard** — Import into phone/contacts apps

### 6. Notification Integration

The `notify-info` subcommand provides integration with the notification system:

```bash
# Get best contact method for notifications
mc contacts notify-info "John Doe"
# Output: John Doe: whatsapp (+1234567890)
```

Priority order: whatsapp → signal → telegram → slack → email → phone

## Files Modified

| File | Change |
|------|--------|
| `lib/contacts.js` | New contacts management module (680 lines) |
| `bin/mc.js` | Added import and registration of contacts command |
| `package.json` | Version bump 0.34.0 → 0.35.0 |
| `README.md` | Added documentation for `mc contacts` command |
| `tests/contacts.test.js` | Comprehensive test suite (18 tests) |

## Test Coverage

```
PASS tests/contacts.test.js
  Contacts Module
    maskContactValue
      ✓ should mask phone numbers showing only last 4 digits
      ✓ should mask email addresses
      ✓ should completely mask sensitive values
      ✓ should return non-sensitive values unchanged
    generateId
      ✓ should generate unique IDs with correct format
      ✓ should include timestamp in ID
    CATEGORIES
      ✓ should have expected categories with icons
    exportToCSV
      ✓ should export contacts to CSV format
      ✓ should handle empty contact list
      ✓ should handle contacts without contact methods
    exportToVCard
      ✓ should export contacts to vCard format
      ✓ should handle multiple contacts
      ✓ should handle WhatsApp and Signal phone types
      ✓ should handle website URLs
  Contacts Security
    Input Validation
      ✓ should validate category is one of allowed values
      ✓ should handle unknown categories gracefully
    ID Generation Security
      ✓ should generate IDs that are not easily guessable
      ✓ should not include sensitive info in IDs

Test Suites: 1 passed, 1 total
Tests:       18 passed, 18 total
```

## Example Usage

### Adding a Contact
```bash
$ mc contacts add
? Contact name: Hetzner Support
? Category: 🏢 Services
? Role/Title: Technical Support
? Organization: Hetzner Online
? Add a contact method? Yes
? Contact method type: email
? Value: support@hetzner.com
? Add another contact method? Yes
? Contact method type: phone
? Value: +49-123-4567890
? Add another contact method? No
? Tags (comma-separated): hosting, critical, infrastructure
? Notes: Primary hosting provider
✅ Added contact: Hetzner Support
```

### Listing Contacts
```bash
$ mc contacts list --category services

🏢 Services
────────────────────────────────────────
  Hetzner Support
     Technical Support @ Hetzner Online
     email: sup*****@hetzner.com
  
Total: 1 contact(s)
```

### Viewing Details
```bash
$ mc contacts show "Hetzner Support" --reveal

🐾 Contact Details

🏢 Hetzner Support
────────────────────────────────────────
  Role: Technical Support
  Organization: Hetzner Online
  Category: Services

Contact Methods:
  email: support@hetzner.com
  phone: +49-123-4567890

Tags: hosting, critical, infrastructure

ID: contact_1771422123456_abc123xyz
Updated: 2/18/2026, 1:45:30 PM
```

### Exporting
```bash
$ mc contacts export --format vcard -o contacts.vcf
✅ Exported 5 contacts to contacts.vcf
```

## Backward Compatibility

- No breaking changes to existing functionality
- New command is additive only
- Contacts stored in rex-deus/context/ (new location)
- Does not interfere with existing contacts.md if present

## Integration Points

1. **rex-deus** — Stores contacts in private context directory
2. **mc notify** — Can use contacts for targeted notifications
3. **mc context** — Contacts can be synced to AI memory
4. **Audit system** — All changes logged for security

## Future Enhancements

Potential future improvements:
- Import from vCard/CSV
- Contact groups/mailing lists
- Integration with `mc notify send --contact <name>`
- Contact history/activity tracking
- Duplicate detection and merging
