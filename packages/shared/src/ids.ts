import { ulid } from 'ulid';

export const newPromptId = (): string => ulid();

export const isUlid = (v: string): boolean => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
