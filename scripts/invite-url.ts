import { inviteUrl, REQUIRED_PERMISSIONS, requiredPermissionBits } from '../src/bot/requiredPermissions.js';

const clientId = process.env.DISCORD_CLIENT_ID;
if (!clientId) {
  console.error('Set DISCORD_CLIENT_ID (in .env or the environment) first.');
  process.exit(1);
}

console.log('Required bot permissions:');
for (const [name, , why] of REQUIRED_PERMISSIONS) console.log(`  - ${name.padEnd(20)} ${why}`);
console.log(`\nPermission integer: ${requiredPermissionBits()}`);
console.log(`\nInvite URL:\n${inviteUrl(clientId, process.env.GUILD_ID)}`);
