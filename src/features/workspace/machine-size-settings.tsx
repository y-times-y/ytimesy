import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RadioGroup } from "radix-ui";
import { MACHINE_SIZES } from "#/domain/machine-size";
import {
	cacheWrite,
	optimisticMutation,
	saveErrorMessage,
} from "#/lib/optimistic-mutation";
import { readMachineSizeFn, saveMachineSizeFn } from "./machine-size.fn";

type MachineSizeId = (typeof MACHINE_SIZES)[number]["id"];

/** Picking a size shows it chosen at once; a failed save puts the old one back. */
export function machineSizeSave(
	queryClient: QueryClient,
	projectId: string,
	save: (input: {
		data: { projectId: string; size: MachineSizeId };
	}) => Promise<MachineSizeId>,
) {
	const queryKey = ["project-machine-size", projectId];
	return {
		mutationFn: (size: MachineSizeId) => save({ data: { projectId, size } }),
		...optimisticMutation<MachineSizeId, MachineSizeId>({
			queryClient,
			scope: `machine-size:${projectId}`,
			writes: (size) => [cacheWrite<MachineSizeId>(queryKey, () => size)],
			serverWrites: (data) => [{ queryKey, data }],
		}),
	};
}

export function MachineSizeSettings({ projectId }: { projectId: string }) {
	const readSize = useServerFn(readMachineSizeFn);
	const saveSize = useServerFn(saveMachineSizeFn);
	const queryClient = useQueryClient();
	const queryKey = ["project-machine-size", projectId];
	const preference = useQuery({
		queryKey,
		queryFn: () => readSize({ data: { projectId } }),
	});
	const save = useMutation(machineSizeSave(queryClient, projectId, saveSize));
	return (
		<section
			className="machine-size-settings"
			aria-labelledby="machine-size-heading"
		>
			<div className="machine-size-heading">
				<h3 id="machine-size-heading">Machine size</h3>
				<span>Per project</span>
			</div>
			<p
				className="settings-copy"
				title="Existing machines keep their size. Larger sizes use your compute allowance faster. A copy of a larger environment snapshot cannot be reduced below that snapshot’s size."
			>
				Resources for new chat machines.
			</p>
			{/* While the choice loads, the same list shows disabled: nothing moves when it lands. */}
			{preference.data || preference.isPending ? (
				<RadioGroup.Root
					orientation="vertical"
					className="machine-size-list"
					aria-label="Machine size"
					aria-busy={preference.isPending}
					value={preference.data ?? ""}
					disabled={!preference.data}
					onValueChange={(value) => {
						const size = MACHINE_SIZES.find((row) => row.id === value);
						if (size) save.mutate(size.id);
					}}
				>
					{MACHINE_SIZES.map((size) => (
						<RadioGroup.Item
							key={size.id}
							value={size.id}
							className="machine-size-option"
						>
							<span className="machine-size-choice">
								<RadioGroup.Indicator />
							</span>
							<span className="machine-size-details">
								<span className="machine-size-title">
									{size.name}
									{size.id === "large" ? (
										<span className="machine-size-default">Default</span>
									) : null}
								</span>
								<span className="machine-size-description">
									{size.description}
								</span>
							</span>
							<span className="machine-size-resources">
								<span>
									{size.cpu} vCPU · {size.memory / 1024} GiB
								</span>
								<span>{size.storage / 1024} GiB disk</span>
							</span>
						</RadioGroup.Item>
					))}
				</RadioGroup.Root>
			) : null}
			{preference.error || save.error ? (
				<p role="alert">
					{preference.error?.message ?? saveErrorMessage(save.error)}
				</p>
			) : null}
		</section>
	);
}
