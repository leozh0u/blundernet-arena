package engine

import (
	"fmt"
	"math"
	"os"
	"runtime"
	"sync"

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

func (e *ONNX) Name() string { return "blundernet-onnx" }

func (e *ONNX) BestMove(fen string) (string, error) {
	pos, err := ParseFEN(fen)
	if err != nil {
		return "", err
	}
	legal := pos.ValidMoves()
	if len(legal) == 0 {
		return "", fmt.Errorf("no legal moves in %q", fen)
	}

	input, err := ort.NewTensor(ort.NewShape(1, Planes, 8, 8), Encode(pos))
	if err != nil {
		return "", err
	}
	defer input.Destroy()

	outputs := []ort.Value{nil, nil}
	if err := e.session.Run([]ort.Value{input}, outputs); err != nil {
		return "", fmt.Errorf("inference: %w", err)
	}
	defer outputs[0].Destroy()
	defer outputs[1].Destroy()

	policy := outputs[0].(*ort.Tensor[float32]).GetData()

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
