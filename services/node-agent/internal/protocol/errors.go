package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrorCode is one of the protocol error codes (AgentErrorCode in envelope.ts).
type ErrorCode string

const (
	CodeValidationFailed   ErrorCode = "VALIDATION_FAILED"
	CodeUnsupportedCommand ErrorCode = "UNSUPPORTED_COMMAND"
	CodeCommandRejected    ErrorCode = "COMMAND_REJECTED"
	CodeNotFound           ErrorCode = "NOT_FOUND"
	CodeAlreadyExists      ErrorCode = "ALREADY_EXISTS"
	CodeConflict           ErrorCode = "CONFLICT"
	CodePathForbidden      ErrorCode = "PATH_FORBIDDEN"
	CodeQuotaExceeded      ErrorCode = "QUOTA_EXCEEDED"
	CodeChecksumMismatch   ErrorCode = "CHECKSUM_MISMATCH"
	CodeDownloadFailed     ErrorCode = "DOWNLOAD_FAILED"
	CodeHostNotAllowed     ErrorCode = "HOST_NOT_ALLOWED"
	CodeImageNotAllowed    ErrorCode = "IMAGE_NOT_ALLOWED"
	CodeRuntimeError       ErrorCode = "RUNTIME_ERROR"
	CodeTimeout            ErrorCode = "TIMEOUT"
	CodeBusy               ErrorCode = "BUSY"
	CodeInternal           ErrorCode = "INTERNAL"
)

// Error is a structured command failure that maps 1:1 onto a `result` error frame.
type Error struct {
	Code      ErrorCode
	Message   string
	Retryable bool
	Details   any
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// Errorf builds a non-retryable protocol error.
func Errorf(code ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// RetryableErrorf builds a retryable protocol error.
func RetryableErrorf(code ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...), Retryable: true}
}

// WithDetails attaches structured details.
func (e *Error) WithDetails(d any) *Error {
	c := *e
	c.Details = d
	return &c
}

// AsError extracts a *Error from an error chain.
func AsError(err error) (*Error, bool) {
	var pe *Error
	if errors.As(err, &pe) {
		return pe, true
	}
	return nil, false
}

// ToAgentError converts to the wire representation.
func (e *Error) ToAgentError() *AgentError {
	ae := &AgentError{Code: e.Code, Message: e.Message, Retryable: e.Retryable}
	if e.Details != nil {
		if b, err := json.Marshal(e.Details); err == nil {
			ae.Details = b
		}
	}
	return ae
}
