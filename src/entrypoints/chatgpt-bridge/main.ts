import { browser } from "#imports"

// Preserve old bookmarks while keeping a single settings entry point.
location.replace(browser.runtime.getURL("/options.html#/api-providers"))
