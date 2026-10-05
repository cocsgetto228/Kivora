module github.com/kivora-im/kivora/server

go 1.24

// Kivora has no third-party dependencies, on purpose.
// A messenger's server is a supply-chain target; every module in this file
// would be code with commit access to your users' metadata. The whole server
// is Go's standard library plus the primitives in internal/crypto.
