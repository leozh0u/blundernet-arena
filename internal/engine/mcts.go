package engine

import (
	"fmt"
	"math"
	"os"
	"strconv"

	"github.com/notnil/chess"
)

// MCTS is PUCT Monte-Carlo Tree Search over the policy/value network,
// the same algorithm the engine trains with. Each simulation walks the
// tree picking the move that maximizes
//
//	Q(s,a) + c_puct * P(s,a) * sqrt(N(s)) / (1 + N(s,a))
//
// exploitation plus a prior-weighted exploration bonus that decays as a
// move gets visited. The move with the most visits at the root wins.
// Raw policy is intuition; the search adds calculation.
type MCTS struct {
	eval  Evaluator
	sims  int
	cPuct float64
}

// Evaluator supplies raw policy logits (4096 from/to pairs) and a value
// in [-1, 1] from the side to move's perspective.
type Evaluator interface {
	Evaluate(pos *chess.Position) (policy []float32, value float32, err error)
}

func NewMCTS(eval Evaluator, sims int) *MCTS {
	return &MCTS{eval: eval, sims: sims, cPuct: 1.5}
}

func (m *MCTS) Name() string { return fmt.Sprintf("blundernet-mcts-%d", m.sims) }

// node mirrors the training implementation: children are stored in
// parallel with the legal moves that lead to them.
type node struct {
	prior    float64
	visits   int
	valueSum float64
	moves    []*chess.Move
	children []*node
}

func (n *node) q() float64 {
	if n.visits == 0 {
		return 0
	}
	return n.valueSum / float64(n.visits)
}

func (n *node) expanded() bool { return len(n.children) > 0 }

// expand fills in children with softmax priors over the legal moves and
// returns the value head's estimate for the position.
func (m *MCTS) expand(n *node, pos *chess.Position) (float64, error) {
	policy, value, err := m.eval.Evaluate(pos)
	if err != nil {
		return 0, err
	}
	n.moves = pos.ValidMoves()
	n.children = make([]*node, len(n.moves))

	// Softmax over the legal moves' logits only, shifted by the max for
	// numerical stability.
	maxLogit := float32(math.Inf(-1))
	for _, mv := range n.moves {
		if l := policy[MoveIndex(mv)]; l > maxLogit {
			maxLogit = l
		}
	}
	var sum float64
	exps := make([]float64, len(n.moves))
	for i, mv := range n.moves {
		exps[i] = math.Exp(float64(policy[MoveIndex(mv)] - maxLogit))
		sum += exps[i]
	}
	for i := range n.children {
		n.children[i] = &node{prior: exps[i] / sum}
	}
	return float64(value), nil
}

// terminalValue reports the game-over value from the side to move's
// perspective: mated (or stalemated with no winner) positions score -1
// and 0 respectively, matching the training convention.
func terminalValue(pos *chess.Position) (float64, bool) {
	switch pos.Status() {
	case chess.Checkmate:
		return -1, true
	case chess.Stalemate:
		return 0, true
	}
	return 0, false
}

func (m *MCTS) BestMove(fen string) (string, error) {
	root := &node{}
	rootPos, err := ParseFEN(fen)
	if err != nil {
		return "", err
	}
	if len(rootPos.ValidMoves()) == 0 {
		return "", fmt.Errorf("no legal moves in %q", fen)
	}
	// Mate-in-one probe before searching. The policy net can assign a
	// mating move a near-zero prior in positions unlike its training
	// data (sparse endgames especially), and PUCT then starves the move
	// of visits. One ply of lookahead costs |moves| status checks and
	// guarantees an immediate mate is never overlooked.
	for _, mv := range rootPos.ValidMoves() {
		if rootPos.Update(mv).Status() == chess.Checkmate {
			return IndexUCI(MoveIndex(mv), rootPos), nil
		}
	}
	if _, err := m.expand(root, rootPos); err != nil {
		return "", err
	}

	for s := 0; s < m.sims; s++ {
		n, pos := root, rootPos
		path := []*node{}

		// 1. Select: walk down via PUCT until a leaf.
		for n.expanded() {
			sqrtN := math.Sqrt(float64(n.visits) + 1)
			bestIdx, bestScore := 0, math.Inf(-1)
			for i, child := range n.children {
				u := m.cPuct * child.prior * sqrtN / float64(1+child.visits)
				// child.q is from the child mover's view; negate it.
				if score := -child.q() + u; score > bestScore {
					bestIdx, bestScore = i, score
				}
			}
			pos = pos.Update(n.moves[bestIdx])
			n = n.children[bestIdx]
			path = append(path, n)
		}

		// 2. Expand and evaluate (network, or the game result itself).
		value, done := terminalValue(pos)
		if !done {
			if value, err = m.expand(n, pos); err != nil {
				return "", err
			}
		}

		// 3. Backpropagate, flipping perspective each ply.
		root.visits++
		for i := len(path) - 1; i >= 0; i-- {
			path[i].visits++
			path[i].valueSum += value
			value = -value
		}
	}

	// Most-visited root move.
	bestIdx := 0
	for i, child := range root.children {
		if child.visits > root.children[bestIdx].visits {
			bestIdx = i
		}
	}
	return IndexUCI(MoveIndex(root.moves[bestIdx]), rootPos), nil
}

// SimsFromEnv reads ENGINE_SIMS, defaulting to 300. Values below 2 mean
// "no search, raw policy".
func SimsFromEnv() int {
	if v := os.Getenv("ENGINE_SIMS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 300
}
