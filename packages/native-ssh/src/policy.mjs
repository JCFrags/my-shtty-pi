export function classifyCommand(command) {
  const text = String(command);
  const sensitivePaths = text.match(/(?:~|\/[A-Za-z0-9._-]+)*\/?(?:\.ssh\/id_[A-Za-z0-9._-]+|\.gnupg(?:\/[A-Za-z0-9._-]+)*|etc\/(?:shadow|gshadow))\b/g) ?? [];
  if (sensitivePaths.some(path => !path.endsWith(".pub")) || /(?:^|[;&|]\s*)(?:cat|head|tail|less|more|cp)\s+[^\n]*(?:\.ssh\/authorized_keys)|(?:password|token|secret|private[_ -]?key)\s*=/i.test(text)) return { kind: "credential", reason: "The command can expose or change credentials. Use a visible Herdr terminal and keep secrets out of Pi." };
  if (/(?:known_hosts|authorized_keys|sshd?_config|ssh-keygen|update-ca-trust|trust\s+(?:anchor|extract))/i.test(text)) return { kind: "trust", reason: "The command changes SSH or certificate trust." };
  if (/(?:^|[;&|]\s*)(?:rm\s+(?:-[^\s]*[rf][^\s]*\s+|--recursive\b)|mkfs\b|wipefs\b|shutdown\b|reboot\b|poweroff\b|halt\b|git\s+(?:reset\s+--hard|clean\s+-[^\s]*f)|(?:DROP|TRUNCATE)\s+(?:DATABASE|TABLE)\b|dd\s+[^\n]*\bof=\/dev\/)/i.test(text)) return { kind: "destructive", reason: "The command appears destructive or difficult to reverse." };
  return null;
}
