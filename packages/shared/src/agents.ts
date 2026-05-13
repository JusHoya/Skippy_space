import { z } from 'zod';

export const SKIPPY_ID = 'skippy' as const;

export const BOARDS = [
  'engineering',
  'coding',
  'design',
  'marketing',
  'finance',
  'research',
  'publishing',
  'devops',
] as const;

export const STAFF_OFFICERS = [
  'agent-creator',
  'skill-auditor',
  'memory-manager',
  'psych-monitor',
] as const;

export type BoardId = (typeof BOARDS)[number];
export type StaffOfficerId = (typeof STAFF_OFFICERS)[number];
export type AgentId =
  | typeof SKIPPY_ID
  | `board.${BoardId}`
  | `staff.${StaffOfficerId}`
  | `task.${string}`;

export const AgentIdSchema = z.string().refine((v): v is AgentId => {
  if (v === SKIPPY_ID) return true;
  if (v.startsWith('board.') && (BOARDS as readonly string[]).includes(v.slice(6))) return true;
  if (v.startsWith('staff.') && (STAFF_OFFICERS as readonly string[]).includes(v.slice(6))) return true;
  if (v.startsWith('task.') && v.length > 5) return true;
  return false;
}, { message: 'invalid AgentId' });
