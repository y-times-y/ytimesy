import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RadioGroup } from "radix-ui";
import { MACHINE_SIZES } from "#/domain/machine-size";
import { readMachineSizeFn, saveMachineSizeFn } from "./machine-size.fn";

export function MachineSizeSettings({ projectId }: { projectId: string }) {
	const readSize = useServerFn(readMachineSizeFn);
	const saveSize = useServerFn(saveMachineSizeFn);
	const queryClient = useQueryClient();
	const queryKey = ["project-machine-size", projectId];
	const preference = useQuery({
		queryKey,
		queryFn: () => readSize({ data: { projectId } }),
	});
	const save = useMutation({
		mutationFn: (size: (typeof MACHINE_SIZES)[number]["id"]) =>
			saveSize({ data: { projectId, size } }),
		onSuccess: (size) => queryClient.setQueryData(queryKey, size),
	});
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
			{preference.data ? (
				<RadioGroup.Root
					orientation="vertical"
					className="machine-size-list"
					aria-label="Machine size"
					value={preference.data}
					disabled={save.isPending}
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
			) : preference.isPending ? (
				<p className="settings-copy">Reading machine preference…</p>
			) : null}
			{save.isPending ? (
				<p role="status" className="settings-copy">
					Saving preference…
				</p>
			) : null}
			{preference.error || save.error ? (
				<p role="alert">{(preference.error ?? save.error)?.message}</p>
			) : null}
		</section>
	);
}
