from geometry import circle_area, rect_area


def total():
    return circle_area(2) + rect_area(3, 4)


def report():
    return f"total={total():.2f}"
