import { MatrixDotLoader } from "./matrix-dot-loader";

function Spinner(props: React.ComponentProps<"span">) {
	return (
		<MatrixDotLoader
			data-slot="spinner"
			role="status"
			aria-label="Loading"
			{...props}
			aria-hidden={undefined}
		/>
	);
}

export { Spinner };
