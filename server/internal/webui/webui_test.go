package webui

import "testing"

// "Cache forever, immutable" is only safe for a name that changes when the
// bytes change. Getting this wrong is invisible in development and shows up as
// "the server updated but the app did not" in production, so it is pinned.
func TestOnlyContentHashedNamesAreImmutable(t *testing.T) {
	immutable := []string{
		"assets/main-9zz35nt4.js",
		"assets/index-DkH3s9Qa.css",
		"assets/crypto-B7fK2xQ1.js",
		"assets/main-abcdefgh12345678.js",
	}
	for _, name := range immutable {
		if !looksContentHashed(name) {
			t.Errorf("%s should be treated as content-hashed", name)
		}
	}

	revalidate := []string{
		"assets/main.js",          // the shape that caused the bug
		"assets/main.css",         //
		"assets/vendor-abc.js",    // too short to be a hash
		"assets/my-app.js",        // a dash, but a word after it
		"index.html",              // the entry document, never immutable
		"assets/noextension",      //
		"assets/main-9zz.35nt.js", // dot inside the would-be hash
	}
	for _, name := range revalidate {
		if looksContentHashed(name) {
			t.Errorf("%s must NOT be treated as content-hashed", name)
		}
	}
}

// The status code has to tell a real page from a dead link.
//
// A blanket 200 for every unknown path hides broken links from crawlers and
// uptime monitors; a blanket 404 marks the admin console as missing. Both are
// one-line mistakes, so both are pinned here.
func TestClientRoutesAnswerTwoHundred(t *testing.T) {
	real := []string{"", ".", "index.html", "admin", "admin/users", "admin/pages"}
	for _, path := range real {
		if !isClientRoute(path) {
			t.Errorf("%q is a real client route and must answer 200", path)
		}
	}

	dead := []string{"admin/nope", "chats", "settings", "wp-login.php", "admin/users/1"}
	for _, path := range dead {
		if isClientRoute(path) {
			t.Errorf("%q is not a route and must answer 404", path)
		}
	}
}

// This list mirrors parseRoute() in web/src/lib/session.ts. Nothing can enforce
// that automatically across the two languages, so the test at least states the
// obligation where someone adding a route will see it.
func TestRouteTableMatchesTheClient(t *testing.T) {
	want := []string{"admin", "admin/overview", "admin/users", "admin/channels", "admin/security", "admin/pages"}
	for _, path := range want {
		if !clientRoutes[path] {
			t.Errorf("client route %q is missing from webui.clientRoutes", path)
		}
	}
}
