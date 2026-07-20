// Package engine picks moves for the bot side. The real engine runs the
// exported BlunderNet ONNX model; a small material searcher stands in when
// the model or ONNX Runtime library is unavailable (CI, fresh clones).
package engine

import (
	"log"
	"os"
)

type Engine interface {
	// BestMove returns a UCI move for the side to move in fen.
	BestMove(fen string) (string, error)
	Name() string
}

// NewFromEnv builds the strongest engine the environment supports.
// MODEL_PATH points at the .onnx file; ONNXRUNTIME_LIB at the shared
// library. Both have sensible defaults for local dev.
func NewFromEnv() Engine {
	modelPath := envOr("MODEL_PATH", "models/blundernet.onnx")
	if _, err := os.Stat(modelPath); err != nil {
		log.Printf("engine: model %s not found, using material fallback", modelPath)
		return NewMaterial()
	}
	eng, err := NewONNX(modelPath)
	if err != nil {
		log.Printf("engine: onnx unavailable (%v), using material fallback", err)
		return NewMaterial()
	}
	log.Printf("engine: %s", eng.Name())
	return eng
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
