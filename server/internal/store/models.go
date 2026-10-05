package store

type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	DisplayName  string `json:"displayName"`
	PasswordHash string `json:"-"`
	AvatarHue    int    `json:"avatarHue"`
	// Avatar is an attachment id, or "" for the generated initials avatar.
	Avatar     string `json:"avatar"`
	Bio        string `json:"bio"`
	IsAdmin    bool   `json:"isAdmin"`
	Suspended  bool   `json:"suspended"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
}

type Device struct {
	ID              string `json:"id"`
	UserID          string `json:"userId"`
	Name            string `json:"name"`
	Platform        string `json:"platform"`
	Suite           string `json:"suite"`
	IdentityPub     []byte `json:"identityPub"`
	SignedPreKeyPub []byte `json:"signedPreKeyPub"`
	SignedPreKeySig []byte `json:"signedPreKeySig"`
	CreatedAt       int64  `json:"createdAt"`
	LastSeenAt      int64  `json:"lastSeenAt"`
	Revoked         bool   `json:"revoked"`
}

// KeyBundle is what a client fetches before it can encrypt to a device.
type KeyBundle struct {
	Device   Device `json:"device"`
	PreKeyID string `json:"preKeyId,omitempty"`
	PreKey   []byte `json:"preKey,omitempty"`
}

type Channel struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // dm | group | channel | thread
	// ParentID is set for threads: a thread lives inside a group but carries
	// its own member list and its own key, so the rest of the group cannot
	// read it.
	ParentID  string `json:"parentId,omitempty"`
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	Topic     string `json:"topic"`
	Avatar    string `json:"avatar"`
	OwnerID   string `json:"ownerId"`
	Encrypted bool   `json:"encrypted"`
	Suite     string `json:"suite"`
	CreatedAt int64  `json:"createdAt"`
	LastSeq   int64  `json:"lastSeq"`
	LastMsgAt int64  `json:"lastMsgAt"`

	// TTLSeconds makes messages in this chat disappear. 0 means "keep them".
	// It is a property of the chat, not of one person's view: a timer that
	// only cleared your own copy would be a comfort, not a feature.
	TTLSeconds int64 `json:"ttlSeconds"`

	// Projected fields, filled per requesting user.
	Members     []Member `json:"members,omitempty"`
	Unread      int64    `json:"unread"`
	LastReadSeq int64    `json:"lastReadSeq"`
	LastMessage *Message `json:"lastMessage,omitempty"`
	Archived    bool     `json:"archived"`
	Pinned      bool     `json:"pinned"`
	Muted       bool     `json:"muted"`
	ThreadCount int      `json:"threadCount"`
	PinnedCount int      `json:"pinnedCount"`
}

type Member struct {
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AvatarHue   int    `json:"avatarHue"`
	Avatar      string `json:"avatar"`
	Role        string `json:"role"`
	LastSeenAt  int64  `json:"lastSeenAt"`
}

type Message struct {
	ID           string `json:"id"`
	ChannelID    string `json:"channelId"`
	Seq          int64  `json:"seq"`
	SenderID     string `json:"senderId"`
	SenderDevice string `json:"senderDevice"`
	Suite        string `json:"suite"`
	Kind         string `json:"kind"` // text | media | file | system
	Header       []byte `json:"header,omitempty"`
	Body         []byte `json:"body"`
	ReplyTo      string `json:"replyTo,omitempty"`
	CreatedAt    int64  `json:"createdAt"`
	EditedAt     int64  `json:"editedAt"`
	Deleted      bool   `json:"deleted"`
	Pinned       bool   `json:"pinned"`
	// Attachments lists the upload ids this message refers to. The bytes stay
	// in the upload store; the message body carries their keys.
	Attachments []string `json:"attachments,omitempty"`

	// WrappedKey is the content key sealed for the *requesting* device only.
	WrappedKey []byte `json:"wrappedKey,omitempty"`
}

// Upload is one stored file. For encrypted channels the bytes are ciphertext
// the server cannot read; `Mime` and `Size` are metadata the client chooses to
// reveal so the UI can show a placeholder before downloading.
type Upload struct {
	ID        string `json:"id"`
	OwnerID   string `json:"ownerId"`
	ChannelID string `json:"channelId"`
	Kind      string `json:"kind"` // media | avatar
	Mime      string `json:"mime"`
	Size      int64  `json:"size"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	Duration  int    `json:"duration,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

type Session struct {
	UserID    string
	DeviceID  string
	ExpiresAt int64
}
