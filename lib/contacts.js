/**
 * Contacts Management Module for MasterClaw CLI
 *
 * Manages Rex's personal and professional contacts in rex-deus:
 * - List, search, and filter contacts
 * - Add/remove/edit contacts
 * - Quick contact lookup for notifications
 * - Import/export contacts
 * - Integration with notify command
 *
 * Security:
 * - Contacts stored in rex-deus (private repo)
 * - Sensitive data masked in logs
 * - Audit logging for all modifications
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');
const { Command } = require('commander');
const { findRexDeusDir } = require('./context');
const { logAudit, AuditEventType } = require('./audit');

const program = new Command('contacts');

// Contact categories
const CATEGORIES = {
  personal: { icon: '👤', label: 'Personal' },
  professional: { icon: '💼', label: 'Professional' },
  technical: { icon: '🔧', label: 'Technical Support' },
  services: { icon: '🏢', label: 'Services' },
  emergency: { icon: '🚨', label: 'Emergency' },
};

// Contact schema
const CONTACT_TEMPLATE = {
  id: '', // unique identifier
  name: '',
  category: 'personal',
  role: '',
  organization: '',
  contactMethods: [],
  notes: '',
  tags: [],
  createdAt: '',
  updatedAt: '',
};

// =============================================================================
// Contact Storage
// =============================================================================

const CONTACTS_FILE = 'contacts.json';
const CONTACTS_MD = 'contacts.md';

/**
 * Get the path to contacts storage
 */
async function getContactsPath() {
  const rexDeusDir = await findRexDeusDir();
  if (!rexDeusDir) {
    return null;
  }
  return {
    json: path.join(rexDeusDir, 'context', CONTACTS_FILE),
    markdown: path.join(rexDeusDir, 'context', CONTACTS_MD),
    dir: path.join(rexDeusDir, 'context'),
  };
}

/**
 * Load contacts from JSON storage
 */
async function loadContacts() {
  const paths = await getContactsPath();
  if (!paths) {
    throw new Error('rex-deus directory not found. Ensure rex-deus is cloned.');
  }

  // Try JSON first (structured data)
  if (await fs.pathExists(paths.json)) {
    const data = await fs.readJson(paths.json);
    return data.contacts || [];
  }

  // Fall back to parsing markdown
  if (await fs.pathExists(paths.markdown)) {
    return parseContactsFromMarkdown(await fs.readFile(paths.markdown, 'utf-8'));
  }

  return [];
}

/**
 * Save contacts to JSON storage
 */
async function saveContacts(contacts) {
  const paths = await getContactsPath();
  if (!paths) {
    throw new Error('rex-deus directory not found');
  }

  // Ensure directory exists
  await fs.ensureDir(paths.dir);

  // Save structured JSON
  await fs.writeJson(paths.json, {
    version: '1.0',
    updatedAt: new Date().toISOString(),
    contacts: contacts.sort((a, b) => a.name.localeCompare(b.name)),
  }, { spaces: 2 });

  // Also update markdown for human readability
  await fs.writeFile(paths.markdown, generateContactsMarkdown(contacts));

  // Set secure permissions
  await fs.chmod(paths.json, 0o600);
  await fs.chmod(paths.markdown, 0o600);
}

/**
 * Parse contacts from markdown format (legacy support)
 */
function parseContactsFromMarkdown(content) {
  const contacts = [];
  const sections = content.split(/##\s+/);

  for (const section of sections) {
    const lines = section.split('\n').filter(l => l.trim());
    if (lines.length === 0) continue;

    // Extract category from header
    const categoryMatch = lines[0].match(/^(\w+)\s*Contacts/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'personal';

    // Parse contact entries
    let currentContact = null;
    for (const line of lines.slice(1)) {
      if (line.startsWith('### ')) {
        if (currentContact) contacts.push(currentContact);
        currentContact = {
          id: generateId(),
          name: line.replace('### ', '').trim(),
          category: category in CATEGORIES ? category : 'personal',
          contactMethods: [],
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      } else if (currentContact) {
        // Parse contact details
        const roleMatch = line.match(/\*\*Role:\*\*\s*(.+)/i);
        if (roleMatch) currentContact.role = roleMatch[1].trim();

        const orgMatch = line.match(/\*\*Organization:\*\*\s*(.+)/i);
        if (orgMatch) currentContact.organization = orgMatch[1].trim();

        const contactMatch = line.match(/[-*]\s*(\w+):\s*(.+)/);
        if (contactMatch) {
          currentContact.contactMethods.push({
            type: contactMatch[1].toLowerCase(),
            value: contactMatch[2].trim(),
          });
        }
      }
    }
    if (currentContact) contacts.push(currentContact);
  }

  return contacts;
}

/**
 * Generate markdown from contacts
 */
function generateContactsMarkdown(contacts) {
  const lines = [
    '# Contacts & Relationships 👥',
    '',
    '*People that matter and how to reach them.*',
    '',
    '**Privacy Notice:** This file is private. Do not share.',
    '',
    '---',
    '',
    '> 💡 **CLI Tip**: Use `mc contacts list` to search and filter contacts.',
    '> Use `mc contacts show <name>` for quick lookup.',
    '',
  ];

  // Group by category
  const byCategory = {};
  for (const contact of contacts) {
    const cat = contact.category || 'personal';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(contact);
  }

  // Generate sections
  for (const [key, info] of Object.entries(CATEGORIES)) {
    const catContacts = byCategory[key] || [];
    lines.push(`## ${info.icon} ${info.label} Contacts`);
    lines.push('');

    if (catContacts.length === 0) {
      lines.push('*No contacts in this category.*');
      lines.push('');
      continue;
    }

    for (const contact of catContacts) {
      lines.push(`### ${contact.name}`);
      lines.push('');
      if (contact.role) lines.push(`**Role:** ${contact.role}`);
      if (contact.organization) lines.push(`**Organization:** ${contact.organization}`);
      lines.push('');

      if (contact.contactMethods.length > 0) {
        lines.push('**Contact:**');
        for (const method of contact.contactMethods) {
          const masked = maskContactValue(method.type, method.value);
          lines.push(`- ${method.type}: ${masked}`);
        }
        lines.push('');
      }

      if (contact.notes) {
        lines.push(`**Notes:** ${contact.notes}`);
        lines.push('');
      }

      if (contact.tags.length > 0) {
        lines.push(`**Tags:** ${contact.tags.join(', ')}`);
        lines.push('');
      }
    }
  }

  // Add quick reference section
  lines.push('---');
  lines.push('');
  lines.push('## Quick Reference');
  lines.push('');
  lines.push('| Category | Count | Command |');
  lines.push('|----------|-------|---------|');
  for (const [key, info] of Object.entries(CATEGORIES)) {
    const count = byCategory[key]?.length || 0;
    lines.push(`| ${info.icon} ${info.label} | ${count} | \`mc contacts list --category ${key}\` |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Keep connections alive. Relationships are the real wealth.* 🐾');
  lines.push('');

  return lines.join('\n');
}

/**
 * Mask sensitive contact values
 */
function maskContactValue(type, value) {
  const lowerType = type.toLowerCase();

  if (lowerType.includes('phone') || lowerType.includes('whatsapp') || lowerType.includes('signal')) {
    // Show last 4 digits of phone - handle non-digit chars
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 4) return value;
    const masked = digits.slice(0, -4).replace(/./g, '*') + digits.slice(-4);
    // Reconstruct with original formatting if possible
    let result = '';
    let digitIndex = 0;
    for (const char of value) {
      if (/\d/.test(char)) {
        result += digitIndex < digits.length - 4 ? '*' : char;
        digitIndex++;
      } else {
        result += char;
      }
    }
    return result || masked;
  }

  if (lowerType.includes('email')) {
    // Show first 2 and last 2 of local part
    const [local, domain] = value.split('@');
    if (local.length <= 4) return value;
    return `${local.slice(0, 2)}***${local.slice(-2)}@${domain}`;
  }

  if (lowerType.includes('key') || lowerType.includes('token') || lowerType.includes('password')) {
    return '********';
  }

  return value;
}

/**
 * Generate unique ID
 */
function generateId() {
  return `contact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// =============================================================================
// Commands
// =============================================================================

program
  .description('Manage contacts in rex-deus');

// List contacts
program
  .command('list')
  .description('List all contacts')
  .option('-c, --category <cat>', 'Filter by category (personal, professional, technical, services, emergency)')
  .option('-t, --tag <tag>', 'Filter by tag')
  .option('-s, --search <query>', 'Search by name or organization')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const contacts = await loadContacts();

    let filtered = contacts;

    if (options.category) {
      filtered = filtered.filter(c => c.category === options.category);
    }

    if (options.tag) {
      filtered = filtered.filter(c => c.tags?.includes(options.tag));
    }

    if (options.search) {
      const query = options.search.toLowerCase();
      filtered = filtered.filter(c =>
        c.name.toLowerCase().includes(query) ||
        c.organization?.toLowerCase().includes(query) ||
        c.role?.toLowerCase().includes(query)
      );
    }

    if (options.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    console.log(chalk.blue('🐾 Contacts\n'));

    if (filtered.length === 0) {
      console.log(chalk.yellow('No contacts found.'));
      console.log(chalk.gray('Add a contact with: mc contacts add'));
      return;
    }

    // Group by category
    const byCategory = {};
    for (const contact of filtered) {
      const cat = contact.category || 'personal';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(contact);
    }

    for (const [key, info] of Object.entries(CATEGORIES)) {
      const catContacts = byCategory[key];
      if (!catContacts || catContacts.length === 0) continue;

      console.log(`${info.icon} ${chalk.bold(info.label)}`);
      console.log(chalk.gray('─'.repeat(40)));

      for (const contact of catContacts) {
        console.log(`  ${chalk.cyan(contact.name)}`);
        if (contact.role) {
          console.log(chalk.gray(`     ${contact.role}${contact.organization ? ` @ ${contact.organization}` : ''}`));
        }
        if (contact.contactMethods.length > 0) {
          const primary = contact.contactMethods[0];
          console.log(chalk.gray(`     ${primary.type}: ${maskContactValue(primary.type, primary.value)}`));
        }
      }
      console.log('');
    }

    console.log(chalk.gray(`Total: ${filtered.length} contact(s)`));
  });

// Show contact details
program
  .command('show <name>')
  .description('Show detailed information for a contact')
  .option('--reveal', 'Show full contact values (not masked)')
  .action(async (name, options) => {
    const contacts = await loadContacts();
    const contact = contacts.find(c =>
      c.name.toLowerCase() === name.toLowerCase() ||
      c.id === name
    );

    if (!contact) {
      // Try partial match
      const matches = contacts.filter(c =>
        c.name.toLowerCase().includes(name.toLowerCase())
      );

      if (matches.length === 1) {
        return showContactDetails(matches[0], options.reveal);
      } else if (matches.length > 1) {
        console.log(chalk.yellow(`Multiple matches found:`));
        for (const m of matches) {
          console.log(`  - ${m.name}`);
        }
        return;
      }

      console.log(chalk.red(`Contact "${name}" not found.`));
      process.exit(1);
    }

    await showContactDetails(contact, options.reveal);
  });

async function showContactDetails(contact, reveal = false) {
  const catInfo = CATEGORIES[contact.category] || CATEGORIES.personal;

  console.log(chalk.blue(`🐾 Contact Details\n`));
  console.log(`${catInfo.icon} ${chalk.bold(contact.name)}`);
  console.log(chalk.gray('─'.repeat(40)));

  if (contact.role) {
    console.log(`  ${chalk.gray('Role:')} ${contact.role}`);
  }
  if (contact.organization) {
    console.log(`  ${chalk.gray('Organization:')} ${contact.organization}`);
  }
  console.log(`  ${chalk.gray('Category:')} ${catInfo.label}`);
  console.log('');

  if (contact.contactMethods.length > 0) {
    console.log(chalk.bold('Contact Methods:'));
    for (const method of contact.contactMethods) {
      const value = reveal ? method.value : maskContactValue(method.type, method.value);
      console.log(`  ${method.type}: ${chalk.cyan(value)}`);
    }
    console.log('');
  }

  if (contact.tags?.length > 0) {
    console.log(`${chalk.gray('Tags:')} ${contact.tags.join(', ')}`);
  }

  if (contact.notes) {
    console.log('');
    console.log(chalk.gray('Notes:'));
    console.log(contact.notes);
  }

  console.log('');
  console.log(chalk.gray(`ID: ${contact.id}`));
  console.log(chalk.gray(`Updated: ${new Date(contact.updatedAt).toLocaleString()}`));
}

// Add contact
program
  .command('add')
  .description('Add a new contact')
  .option('--name <name>', 'Contact name')
  .option('--category <cat>', 'Category (personal, professional, technical, services, emergency)')
  .option('--role <role>', 'Role/title')
  .option('--org <org>', 'Organization')
  .action(async (options) => {
    const contacts = await loadContacts();

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Contact name:',
        when: !options.name,
        validate: (input) => input.length > 0 || 'Name is required',
      },
      {
        type: 'list',
        name: 'category',
        message: 'Category:',
        when: !options.category,
        choices: Object.entries(CATEGORIES).map(([key, info]) => ({
          name: `${info.icon} ${info.label}`,
          value: key,
        })),
      },
      {
        type: 'input',
        name: 'role',
        message: 'Role/Title:',
        when: !options.role,
      },
      {
        type: 'input',
        name: 'organization',
        message: 'Organization:',
        when: !options.org,
      },
      {
        type: 'confirm',
        name: 'addContactMethod',
        message: 'Add a contact method?',
        default: true,
      },
    ]);

    const contact = {
      id: generateId(),
      name: options.name || answers.name,
      category: options.category || answers.category,
      role: options.role || answers.role || '',
      organization: options.org || answers.organization || '',
      contactMethods: [],
      tags: [],
      notes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Add contact methods
    if (answers.addContactMethod) {
      let adding = true;
      while (adding) {
        const method = await inquirer.prompt([
          {
            type: 'list',
            name: 'type',
            message: 'Contact method type:',
            choices: [
              'email',
              'phone',
              'whatsapp',
              'signal',
              'telegram',
              'discord',
              'slack',
              'twitter',
              'github',
              'website',
              'other',
            ],
          },
          {
            type: 'input',
            name: 'value',
            message: 'Value:',
            validate: (input) => input.length > 0 || 'Value is required',
          },
          {
            type: 'confirm',
            name: 'another',
            message: 'Add another contact method?',
            default: false,
          },
        ]);

        contact.contactMethods.push({
          type: method.type,
          value: method.value,
        });

        adding = method.another;
      }
    }

    // Add tags
    const tagsAnswer = await inquirer.prompt([
      {
        type: 'input',
        name: 'tags',
        message: 'Tags (comma-separated):',
      },
    ]);

    if (tagsAnswer.tags) {
      contact.tags = tagsAnswer.tags.split(',').map(t => t.trim()).filter(Boolean);
    }

    // Add notes
    const notesAnswer = await inquirer.prompt([
      {
        type: 'input',
        name: 'notes',
        message: 'Notes:',
      },
    ]);

    contact.notes = notesAnswer.notes;

    contacts.push(contact);
    await saveContacts(contacts);

    await logAudit(AuditEventType.CONFIG_WRITE, {
      action: 'contact_add',
      contactId: contact.id,
      contactName: contact.name,
    });

    console.log(chalk.green(`✅ Added contact: ${contact.name}`));
  });

// Remove contact
program
  .command('remove <name>')
  .description('Remove a contact')
  .option('--force', 'Skip confirmation')
  .action(async (name, options) => {
    const contacts = await loadContacts();
    const index = contacts.findIndex(c =>
      c.name.toLowerCase() === name.toLowerCase() ||
      c.id === name
    );

    if (index === -1) {
      console.log(chalk.red(`Contact "${name}" not found.`));
      process.exit(1);
    }

    const contact = contacts[index];

    if (!options.force) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Remove ${contact.name}?`,
          default: false,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
      }
    }

    contacts.splice(index, 1);
    await saveContacts(contacts);

    await logAudit(AuditEventType.CONFIG_WRITE, {
      action: 'contact_remove',
      contactId: contact.id,
      contactName: contact.name,
    });

    console.log(chalk.green(`✅ Removed contact: ${contact.name}`));
  });

// Export contacts
program
  .command('export')
  .description('Export contacts to file')
  .option('-o, --output <file>', 'Output file', 'contacts-backup.json')
  .option('--format <format>', 'Export format (json, csv, vcard)', 'json')
  .action(async (options) => {
    const contacts = await loadContacts();

    let output;
    switch (options.format) {
      case 'csv':
        output = exportToCSV(contacts);
        break;
      case 'vcard':
        output = exportToVCard(contacts);
        break;
      default:
        output = JSON.stringify({ contacts, exportedAt: new Date().toISOString() }, null, 2);
    }

    await fs.writeFile(options.output, output);
    console.log(chalk.green(`✅ Exported ${contacts.length} contacts to ${options.output}`));
  });

function exportToCSV(contacts) {
  const lines = ['Name,Category,Role,Organization,Primary Contact'];
  for (const c of contacts) {
    const primary = c.contactMethods[0] ? `${c.contactMethods[0].type}:${c.contactMethods[0].value}` : '';
    lines.push(`"${c.name}",${c.category},"${c.role || ''}","${c.organization || ''}","${primary}"`);
  }
  return lines.join('\n');
}

function exportToVCard(contacts) {
  const cards = [];
  for (const c of contacts) {
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${c.name}`,
    ];

    if (c.organization) {
      lines.push(`ORG:${c.organization}`);
    }

    if (c.role) {
      lines.push(`TITLE:${c.role}`);
    }

    for (const method of c.contactMethods) {
      switch (method.type) {
        case 'email':
          lines.push(`EMAIL:${method.value}`);
          break;
        case 'phone':
        case 'whatsapp':
        case 'signal':
          lines.push(`TEL;TYPE=${method.type.toUpperCase()}:${method.value}`);
          break;
        case 'website':
          lines.push(`URL:${method.value}`);
          break;
      }
    }

    lines.push('END:VCARD');
    cards.push(lines.join('\n'));
  }
  return cards.join('\n\n');
}

// Stats command
program
  .command('stats')
  .description('Show contact statistics')
  .action(async () => {
    const contacts = await loadContacts();

    console.log(chalk.blue('🐾 Contact Statistics\n'));

    const byCategory = {};
    for (const c of contacts) {
      const cat = c.category || 'personal';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }

    console.log(chalk.bold('By Category:'));
    for (const [key, info] of Object.entries(CATEGORIES)) {
      const count = byCategory[key] || 0;
      console.log(`  ${info.icon} ${info.label}: ${chalk.cyan(count)}`);
    }

    console.log('');
    console.log(chalk.bold('Total Contacts:'), chalk.cyan(contacts.length));

    if (contacts.length > 0) {
      const oldest = new Date(Math.min(...contacts.map(c => new Date(c.createdAt))));
      console.log(chalk.bold('First Contact Added:'), chalk.gray(oldest.toLocaleDateString()));
    }
  });

// Notify integration - get contact info for notifications
program
  .command('notify-info <name>')
  .description('Get notification contact info for a contact (used by mc notify)')
  .option('--json', 'Output as JSON')
  .action(async (name, options) => {
    const contacts = await loadContacts();
    const contact = contacts.find(c =>
      c.name.toLowerCase() === name.toLowerCase() ||
      c.id === name
    );

    if (!contact) {
      console.error(chalk.red(`Contact "${name}" not found.`));
      process.exit(1);
    }

    // Find best notification method
    const priority = ['whatsapp', 'signal', 'telegram', 'slack', 'email', 'phone'];
    const method = contact.contactMethods.find(m =>
      priority.includes(m.type.toLowerCase())
    );

    const result = {
      name: contact.name,
      available: !!method,
      method: method?.type || null,
      value: method?.value || null,
      allMethods: contact.contactMethods.map(m => ({ type: m.type, value: m.value })),
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.available) {
      console.log(`${result.name}: ${result.method} (${result.value})`);
    } else {
      console.log(chalk.yellow(`${result.name} has no notification-capable contact methods.`));
    }
  });

module.exports = {
  program,
  contactsCmd: program,
  loadContacts,
  saveContacts,
  maskContactValue,
  generateId,
  CATEGORIES,
  exportToCSV,
  exportToVCard,
};
