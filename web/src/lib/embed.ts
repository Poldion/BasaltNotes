/** Ursprung des einbettenden Fensters (für gezieltes postMessage). */
function parentOrigin(allowed: string[]): string {
  try {
    const o = document.referrer ? new URL(document.referrer).origin : null
    if (o && (o === location.origin || allowed.includes(o))) return o
  } catch {
    // ignorieren
  }
  return location.origin
}

let allowedOrigins: string[] = []

export function setAllowedOrigins(list: string[]) {
  allowedOrigins = list
}

export function getAllowedOrigins() {
  return allowedOrigins
}

/** Nachricht an das einbettende Fenster (nur an erlaubte Ursprünge). */
export function postToParent(msg: Record<string, any>) {
  if (window.parent === window) return
  window.parent.postMessage(msg, parentOrigin(allowedOrigins))
}
