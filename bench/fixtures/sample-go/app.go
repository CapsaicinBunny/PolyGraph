package sample

import "fmt"

func Total() float64 {
	return CircleArea(2) + RectArea(3, 4)
}

func Report() string {
	return fmt.Sprintf("total=%.2f", Total())
}
