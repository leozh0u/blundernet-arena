package engine

import (
	"fmt"
	"math"
	"os"
	"runtime"
	"sync"

	"github.com/notnil/chess"
	ort "github.com/yalue/onnxruntime_go"
)

var ortInit sync.Once

// ONNX runs the exported BlunderNet policy/value network and plays the
// highest-probability legal move. Underpromotions were folded into queen
// promotions at training time, so the index->move mapping restores them.
type ONNX struct {
	session *ort.DynamicAdvancedSession
}

func NewONNX(modelPath string) (*ONNX, error) {
	var initErr error
	ortInit.Do(func() {
		if lib := ortLibPath(); lib != "" {
			ort.SetSharedLibraryPath(lib)
		}
		initErr = ort.InitializeEnvironment()
	})
	if initErr != nil {
		return nil, fmt.Errorf("init onnxruntime: %w", initErr)
	}
	sess, err := ort.NewDynamicAdvancedSession(
		modelPath, []string{"board"}, []string{"policy", "value"}, nil,
	)
	if err != nil {
		return nil, fmt.Errorf("load %s: %w", modelPath, err)
	}
	return &ONNX{session: sess}, nil
}

func (e *ONNX) Name() string { return "blundernet-policy" }

// Evaluate runs one forward pass: raw policy logits over all 4096
// from/to pairs, and the value head's score for the side to move.
func (e *ONNX) Evaluate(pos *chess.Position) ([]float32, float32, error) {
	input, err := ort.NewTensor(ort.NewShape(1, Planes, 8, 8), Encode(pos))
	if err != nil {
		return nil, 0, err
	}
	defer input.Destroy()

	outputs := []ort.Value{nil, nil}
	if err := e.session.Run([]ort.Value{input}, outputs); err != nil {
		return nil, 0, fmt.Errorf("inference: %w", err)
	}
	defer outputs[0].Destroy()
	defer outputs[1].Destroy()

	logits := outputs[0].(*ort.Tensor[float32]).GetData()
	value := outputs[1].(*ort.Tensor[float32]).GetData()[0]
	// The tensor buffers are freed on Destroy; hand back a copy.
	policy := make([]float32, len(logits))
	copy(policy, logits)
	return policy, value, nil
}

// BestMove plays the highest-logit legal move with no search. Kept as the
// sims<=1 configuration and as a baseline to compare the search against.
func (e *ONNX) BestMove(fen string) (string, error) {
	pos, err := ParseFEN(fen)
	if err != nil {
		return "", err
	}
	legal := pos.ValidMoves()
	if len(legal) == 0 {
		return "", fmt.Errorf("no legal moves in %q", fen)
	}
	policy, _, err := e.Evaluate(pos)
	if err != nil {
		return "", err
	}
	// Mask to legal moves and take the argmax. Multiple legal moves can
	// share an index only via promotion folding, which maps to the same
	// from/to squares anyway.
	best, bestScore := legal[0], float32(math.Inf(-1))
	for _, m := range legal {
		if s := policy[MoveIndex(m)]; s > bestScore {
			best, bestScore = m, s
		}
	}
	return IndexUCI(MoveIndex(best), pos), nil
}

func ortLibPath() string {
	if v := os.Getenv("ONNXRUNTIME_LIB"); v != "" {
		return v
	}
	candidates := map[string][]string{
		"darwin": {"/opt/homebrew/lib/libonnxruntime.dylib", "/usr/local/lib/libonnxruntime.dylib"},
		"linux":  {"/usr/lib/libonnxruntime.so", "/usr/local/lib/libonnxruntime.so"},
	}
	for _, p := range candidates[runtime.GOOS] {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}
